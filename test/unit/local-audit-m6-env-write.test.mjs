import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const VALUES = ['Ab&cd1234', 'Ab|cd1234', 'a\\1b/c&&d|e', 'q\'uo"te$HOME`x`', 'plain-value']

function fn(src, name) {
  const start = src.indexOf(`${name}() {`)
  assert.ok(start >= 0, name)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end + 3)
}

function run(shell, script, env) {
  const r = spawnSync(shell, ['-c', script], { env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r
}

test('M6: docker-entrypoint writes .env values with sed metacharacters verbatim', () => {
  const src = fs.readFileSync(path.join(root, 'scripts', 'docker-entrypoint.sh'), 'utf8')
  assert.doesNotMatch(src, /sed -i/)
  const lib = [
    fn(src, 'env_write_line'),
    fn(src, 'env_set'),
    fn(src, 'env_get_file'),
    fn(src, 'env_upsert_if_empty'),
  ].join('\n')
  for (const value of VALUES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-env-'))
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, 'A=1\nVM2API_ADMIN_PASSWORD=old\nB=2\nVM2API_ADMIN_PASSWORD=dup\n')
    run(
      'sh',
      `set -eu\n${lib}\nenv_set VM2API_ADMIN_PASSWORD "$V" "$F"\nenv_set NEW_KEY "$V" "$F"\nenv_upsert_if_empty EMPTY_KEY "$V" "$F"`,
      {
        V: value,
        F: file,
      },
    )
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
    assert.deepEqual(
      lines,
      ['A=1', `VM2API_ADMIN_PASSWORD=${value}`, 'B=2', `NEW_KEY=${value}`, `EMPTY_KEY=${value}`],
      value,
    )
  }
})

test('M6: deploy/install.sh env_set writes values verbatim too', () => {
  const src = fs.readFileSync(path.join(root, 'deploy', 'install.sh'), 'utf8')
  assert.doesNotMatch(src, /sed -i "s\|\^\$\{name\}/)
  const lib = fn(src, 'env_set')
  for (const value of VALUES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-env-'))
    fs.writeFileSync(path.join(dir, '.env'), 'VM2API_ADMIN_PASSWORD=old\nX=1\n')
    run('bash', `set -euo pipefail\n${lib}\nenv_set VM2API_ADMIN_PASSWORD "$V"`, { V: value, INSTALL_DIR: dir })
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), `VM2API_ADMIN_PASSWORD=${value}\nX=1\n`, value)
  }
})
