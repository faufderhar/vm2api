#!/bin/sh
set -eu

ROOT="${KIN_PROJECT_ROOT:-/opt/vm2api}"
IMAGE_BIN="/opt/vm2api/image-bin"
mkdir -p "$ROOT/vms" "$ROOT/data" "$ROOT/bin"

# 镜像安装没有仓库 checkout：把镜像内默认配置补进被 bind-mount 覆盖的 src/config。
mkdir -p "$ROOT/src/config"
if [ -d /opt/vm2api/image-config ]; then
  for f in /opt/vm2api/image-config/*; do
    [ -f "$f" ] || continue
    dest="$ROOT/src/config/$(basename "$f")"
    [ -f "$dest" ] || cp "$f" "$dest"
  done
fi

# No seeded vm-01. A fresh fleet is empty. Seeding an active placeholder made
# the only slot undeletable: DELETE refuses the active VM, and the next start
# would recreate the files.

ensure_bin() {
  name="$1"
  dest="$ROOT/bin/$name"
  src="$IMAGE_BIN/$name"
  if [ ! -f "$src" ]; then
    if [ -f "$dest" ]; then
      chmod 755 "$dest" || true
    fi
    return 0
  fi
  tmp="$dest.new"
  cp "$src" "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest"
}
ensure_bin kin-kernel
ensure_bin kin-egress
ensure_bin kin-slot-gate
ensure_bin kin-worker
ensure_bin kin-api-kernel
ensure_bin kin-codex-kernel
ensure_bin kin-grok-kernel
ensure_bin kin-oauth-auth
ensure_bin kin-computer
KERNEL="${KIN_KERNEL_BIN:-$ROOT/bin/kin-kernel}"
if [ ! -x "$KERNEL" ]; then
  echo "vm2api: $KERNEL missing or not executable after image-bin copy. Rebuild with docker compose build, or put linux amd64 Release files in $ROOT/bin." >&2
  exit 1
fi
API_KERNEL="${KIN_API_KERNEL_BIN:-$ROOT/bin/kin-api-kernel}"
if [ ! -x "$API_KERNEL" ]; then
  echo "vm2api: $API_KERNEL missing or not executable after image-bin copy. Rebuild the control-plane image so kin-api-kernel is staged in image-bin." >&2
  exit 1
fi
mkdir -p "$ROOT/share/wrap-cli"
WRAP_CHANGED=0
if [ -d /opt/vm2api/image-wrap-cli ]; then
  # 首装先整目录落地（glibc239 / SAMPLE.json），再由下面的循环按内容覆盖可执行文件。
  if [ ! -f "$ROOT/share/wrap-cli/cli-node" ]; then
    cp -a /opt/vm2api/image-wrap-cli/. "$ROOT/share/wrap-cli/"
    WRAP_CHANGED=1
  fi
  # cli-node 也随镜像覆盖：只在缺失时复制会让升级用户一直留着旧 ELF（#120 baseline 换不进去）。
  for name in kin-kernel.bin kin-kernel cli-node cc-node; do
    src="/opt/vm2api/image-wrap-cli/$name"
    dest="$ROOT/share/wrap-cli/$name"
    if [ -f "$src" ]; then
      if [ ! -f "$dest" ] || ! cmp -s "$src" "$dest"; then
        WRAP_CHANGED=1
      fi
      cp "$src" "$dest.new"
      chmod 755 "$dest.new"
      mv -f "$dest.new" "$dest"
    fi
  done
fi
# The crag kernel no longer comes from a repo checkout; refresh it from the image like the wrap ELFs.
if [ -f /opt/vm2api/image-crag/kin-kernel ]; then
  mkdir -p "$ROOT/share/crag"
  dest="$ROOT/share/crag/kin-kernel"
  if [ ! -f "$dest" ] || ! cmp -s /opt/vm2api/image-crag/kin-kernel "$dest"; then
    cp /opt/vm2api/image-crag/kin-kernel "$dest.new"
    chmod 755 "$dest.new"
    mv -f "$dest.new" "$dest"
    WRAP_CHANGED=1
  fi
fi

if [ ! -S /var/run/docker.sock ]; then
  echo "vm2api: /var/run/docker.sock not mounted; slot create/start will fail." >&2
elif [ -f /opt/vm2api/docker/kin-os/build.mjs ]; then
  # 只拉预构建客体镜像；拉不到不阻塞启动，建槽时再兜底构建。
  node /opt/vm2api/docker/kin-os/build.mjs --pull-only ubuntu || true
fi

env_get_file() {
  name="$1"
  file="$2"
  [ -f "$file" ] || return 0
  grep -E "^${name}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "'" | tr -d '"' | tr -d '\r'
}

env_set() {
  name="$1"
  value="$2"
  file="$3"
  [ -n "$file" ] || return 0
  mkdir -p "$(dirname "$file")"
  touch "$file"
  if grep -qE "^${name}=" "$file"; then
    sed -i "s|^${name}=.*|${name}=${value}|" "$file"
  else
    printf '%s=%s\n' "$name" "$value" >>"$file"
  fi
}

read_secret_file() {
  file="$1"
  [ -f "$file" ] || return 0
  sed -n '1s/^[[:space:]]*//;s/[[:space:]]*$//p' "$file"
}

write_secret_file() {
  file="$1"
  value="$2"
  [ -n "$value" ] || return 0
  mkdir -p "$(dirname "$file")"
  old_umask="$(umask)"
  umask 077
  printf '%s\n' "$value" >"$file"
  umask "$old_umask"
  chmod 600 "$file"
}

env_upsert_if_empty() {
  name="$1"
  value="$2"
  file="$3"
  [ -n "$file" ] || return 0
  if [ -f "$file" ]; then
    current="$(env_get_file "$name" "$file")"
    if [ -n "$current" ]; then
      return 0
    fi
    if grep -qE "^${name}=" "$file"; then
      sed -i "s|^${name}=.*|${name}=${value}|" "$file"
    else
      printf '%s=%s\n' "$name" "$value" >>"$file"
    fi
  fi
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  fi
}

ENVF="${ROOT}/.env"
DATA_DIR="${KIN_DATA_DIR:-$ROOT/data}"
SECRET_DIR="$(dirname "$DATA_DIR")/secrets"
ADMIN_PASSWORD_FILE="$SECRET_DIR/admin.password"
API_KEY_FILE="$SECRET_DIR/api.key"
DB_SECRET_FILE="$SECRET_DIR/db.secret"
if [ -z "${VM2API_ADMIN_USER:-}" ]; then
  VM2API_ADMIN_USER=admin
  export VM2API_ADMIN_USER
  env_upsert_if_empty VM2API_ADMIN_USER admin "$ENVF"
fi
password="${VM2API_ADMIN_PASSWORD:-}"
password_generated=""
if [ -z "$password" ] || [ "$password" = "123456" ]; then
  password="$(read_secret_file "$ADMIN_PASSWORD_FILE")"
fi
if [ -z "$password" ] || [ "$password" = "123456" ]; then
  password="$(env_get_file VM2API_ADMIN_PASSWORD "$ENVF")"
fi
if [ -z "$password" ] || [ "$password" = "123456" ]; then
  password="$(rand_hex)"
  password_generated=1
fi
VM2API_ADMIN_PASSWORD="$password"
export VM2API_ADMIN_PASSWORD
write_secret_file "$ADMIN_PASSWORD_FILE" "$password"
env_set VM2API_ADMIN_PASSWORD "$password" "$ENVF"
if [ -n "$password_generated" ]; then
  # Not printed: container logs are kept and often shipped elsewhere.
  echo "vm2api: generated a panel password for ${VM2API_ADMIN_USER:-admin}; it is in ${ADMIN_PASSWORD_FILE}" >&2
  echo "vm2api: compose mounts that as ./secrets/admin.password. Read it there, then change it after login." >&2
fi

api_key="${VM2API_API_KEY:-}"
if [ -z "$api_key" ]; then
  api_key="${KIN_API_KEY:-}"
fi
api_key_generated=""
if [ -z "$api_key" ]; then
  api_key="$(read_secret_file "$API_KEY_FILE")"
fi
if [ -z "$api_key" ]; then
  api_key="$(env_get_file VM2API_API_KEY "$ENVF")"
fi
if [ -z "$api_key" ]; then
  api_key="$(env_get_file KIN_API_KEY "$ENVF")"
fi
if [ -z "$api_key" ]; then
  api_key="$(rand_hex)"
  api_key_generated=1
fi
if [ -z "${VM2API_API_KEY:-}" ] && [ -z "${KIN_API_KEY:-}" ]; then
  VM2API_API_KEY="$api_key"
  export VM2API_API_KEY
fi
write_secret_file "$API_KEY_FILE" "$api_key"
env_set VM2API_API_KEY "$api_key" "$ENVF"
if [ -n "$api_key_generated" ]; then
  echo "vm2api: generated VM2API_API_KEY (empty in env)." >&2
fi

# Do not invent a database key here. Node reads the mounted secrets/db.secret.
# A key left in the container env file is copied onto that mount once.
if [ -z "${VM2API_DB_SECRET:-}" ] && [ -z "${KIN_DB_SECRET:-}" ]; then
  mounted_db_secret="$(read_secret_file "$DB_SECRET_FILE")"
  saved_db_secret="$(env_get_file VM2API_DB_SECRET "$ENVF")"
  if [ -z "$saved_db_secret" ]; then
    saved_db_secret="$(env_get_file KIN_DB_SECRET "$ENVF")"
  fi
  if [ -n "$saved_db_secret" ] && [ -z "$mounted_db_secret" ]; then
    write_secret_file "$DB_SECRET_FILE" "$saved_db_secret"
    echo "vm2api: copied the database key into ${DB_SECRET_FILE}" >&2
  elif [ -n "$saved_db_secret" ] && [ "$saved_db_secret" != "$mounted_db_secret" ]; then
    echo "vm2api: database key in ${ENVF} differs from ${DB_SECRET_FILE}; keeping the mounted file" >&2
  fi
fi

if [ "$WRAP_CHANGED" = 1 ] && [ "${KIN_AUTO_SYNC_WRAP:-0}" = 1 ]; then
  node /opt/vm2api/scripts/sync-wrap-cli.mjs &
fi

cd /opt/vm2api
exec node src/server.mjs
