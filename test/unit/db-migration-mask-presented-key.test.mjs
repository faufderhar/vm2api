import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/lib/db/database.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = path.join(__dirname, '../../src/lib/db/migrations')

function migrationsUpTo(dir, maxVersion) {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(MIGRATIONS)) {
    const n = Number(f.split('_')[0])
    if (n >= 1 && n <= maxVersion) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
  }
  return dir
}

test('044 masks presented keys already stored in usage_logs and debug records', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mig-mask-'))
  try {
    const dbPath = path.join(tmp, 'kin.db')
    const key = 'sk-vm-' + 'ef'.repeat(32)
    let db = createDatabase({ dbPath, migrationsDir: migrationsUpTo(path.join(tmp, 'm043'), 43) })
    const insert = db.prepare(
      'INSERT INTO usage_logs (id, request_id, created_at, status, api_key_presented) VALUES (?, ?, ?, ?, ?)',
    )
    insert.run('l1', 'r1', '2026-10-01T00:00:00Z', 429, key)
    insert.run('l2', 'r2', '2026-10-01T00:00:01Z', 401, 'short')
    insert.run('l3', 'r3', '2026-10-01T00:00:02Z', 401, null)
    insert.run('l4', 'r4', '2026-10-01T00:00:03Z', 401, 'sk-vm-ab…abcd')
    db.prepare('INSERT INTO request_log_debug (request_id, ts, record_json) VALUES (?, ?, ?)').run(
      'r1',
      '2026-10-01T00:00:00Z',
      JSON.stringify({ request_id: 'r1', api_key_presented: key, status: 429 }),
    )
    db.close()

    db = createDatabase({ dbPath })
    const rows = db.prepare('SELECT id, api_key_presented FROM usage_logs ORDER BY id').all()
    assert.deepEqual(
      rows.map((r) => r.api_key_presented),
      ['sk-vm-ef…efef', '…', null, 'sk-vm-ab…abcd'],
    )
    const debug = JSON.parse(db.prepare('SELECT record_json FROM request_log_debug WHERE request_id = ?').get('r1').record_json)
    assert.equal(debug.api_key_presented, 'sk-vm-ef…efef')
    assert.equal(debug.status, 429)
    db.close()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
