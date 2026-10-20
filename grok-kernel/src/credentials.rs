use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const LOCK_STALE_MS: u128 = 60_000;
const LOCK_WAIT_MS: u128 = 15_000;

#[derive(Clone, Debug)]
pub struct Account {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub expires_at_ms: Option<i64>,
}

pub fn read_account(path: &Path) -> Result<Account, String> {
    let text = fs::read_to_string(path).map_err(|_| "grok_no_credential".to_string())?;
    let doc: Value = serde_json::from_str(&text).map_err(|_| "grok_no_credential".to_string())?;
    let row = doc
        .get("accounts")
        .and_then(|value| value.as_array())
        .and_then(|rows| rows.first())
        .ok_or_else(|| "grok_no_credential".to_string())?;
    let access_token = text_field(row, "access_token");
    let refresh_token = text_field(row, "refresh_token");
    if access_token.is_empty() && refresh_token.is_empty() {
        return Err("grok_no_credential".to_string());
    }
    Ok(Account {
        access_token,
        refresh_token,
        id_token: text_field(row, "id_token"),
        expires_at_ms: number_field(row, "expires_at"),
    })
}

pub fn write_tokens(
    path: &Path,
    access_token: &str,
    refresh_token: &str,
    id_token: &str,
    expires_at_ms: Option<i64>,
) -> Result<(), String> {
    let text = fs::read_to_string(path).unwrap_or_else(|_| "{\"accounts\":[{}]}".to_string());
    let mut doc: Value =
        serde_json::from_str(&text).unwrap_or_else(|_| json!({ "accounts": [{}] }));
    if !doc
        .get("accounts")
        .and_then(|value| value.as_array())
        .is_some()
    {
        doc["accounts"] = json!([{}]);
    }
    if doc["accounts"]
        .as_array()
        .map(|rows| rows.is_empty())
        .unwrap_or(true)
    {
        doc["accounts"] = json!([{}]);
    }
    let row = doc["accounts"][0]
        .as_object_mut()
        .ok_or_else(|| "grok_no_credential".to_string())?;
    row.insert("access_token".to_string(), json!(access_token));
    row.insert("refresh_token".to_string(), json!(refresh_token));
    if !id_token.is_empty() {
        row.insert("id_token".to_string(), json!(id_token));
    }
    if let Some(expires) = expires_at_ms {
        row.insert("expires_at".to_string(), json!(expires));
    }
    row.insert("updated_at".to_string(), json!(iso_now()));
    let rendered = serde_json::to_string_pretty(&doc).map_err(|err| err.to_string())? + "\n";
    atomic_write(path, rendered.as_bytes())
}

pub fn load_agent_id(path: &Path) -> String {
    if let Ok(text) = fs::read_to_string(path) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let id = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = atomic_write(path, format!("{id}\n").as_bytes());
    id
}

pub struct RefreshLock {
    path: std::path::PathBuf,
}

impl Drop for RefreshLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub async fn acquire_refresh_lock(path: &Path) -> Result<RefreshLock, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let deadline = now_ms() + LOCK_WAIT_MS;
    loop {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(path) {
            Ok(mut file) => {
                let _ = write!(file, "{}", std::process::id());
                return Ok(RefreshLock {
                    path: path.to_path_buf(),
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(path) {
                    let _ = fs::remove_file(path);
                    continue;
                }
                if now_ms() > deadline {
                    return Err("grok_refresh_busy".to_string());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(err) => return Err(err.to_string()),
        }
    }
}

fn lock_is_stale(path: &Path) -> bool {
    let modified = fs::metadata(path).and_then(|meta| meta.modified()).ok();
    let Some(modified) = modified else {
        return false;
    };
    modified
        .elapsed()
        .map(|age| age.as_millis() > LOCK_STALE_MS)
        .unwrap_or(false)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&tmp).map_err(|err| err.to_string())?;
        file.write_all(bytes).map_err(|err| err.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn text_field(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn number_field(row: &Value, key: &str) -> Option<i64> {
    let value = row.get(key)?;
    if let Some(number) = value.as_i64() {
        return Some(if number < 1_000_000_000_000 {
            number * 1000
        } else {
            number
        });
    }
    if let Some(number) = value.as_f64() {
        let whole = number as i64;
        return Some(if whole < 1_000_000_000_000 {
            whole * 1000
        } else {
            whole
        });
    }
    None
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn iso_now() -> String {
    // Seconds are enough for the Node reader, which only compares the string for races.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}
