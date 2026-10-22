import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const secureUrl = new URL('../../src/lib/db/secure.mjs', import.meta.url).href

/** One server boot in its own process, like `npm start` without KIN_DATA_DIR. */
function boot(dataDir, blobFile, mode) {
  const env = { ...process.env }
  for (const key of ['KIN_DATA_DIR', 'VM2API_DATA_DIR', 'VM2API_DB_SECRET', 'KIN_DB_SECRET']) delete env[key]
  const script = `
    import fs from 'node:fs'
    const { ensureDbSecretFile, maybeEncrypt, maybeDecrypt, encryptionEnabled } = await import(${JSON.stringify(secureUrl)})
    ensureDbSecretFile(${JSON.stringify(dataDir)})
    if (${JSON.stringify(mode)} === 'write') fs.writeFileSync(${JSON.stringify(blobFile)}, maybeEncrypt('slot-token'))
    const out = { enabled: encryptionEnabled() }
    if (${JSON.stringify(mode)} === 'read') out.plain = maybeDecrypt(fs.readFileSync(${JSON.stringify(blobFile)}, 'utf8'))
    console.log(JSON.stringify(out))
  `
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
    cwd: path.dirname(fileURLToPath(import.meta.url)),
  })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout.trim().split('\n').pop())
}

test('a second boot without KIN_DATA_DIR still decrypts what the first boot wrote', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-db-secret-boot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'data')
  const blob = path.join(root, 'blob')
  assert.deepEqual(boot(dataDir, blob, 'write'), { enabled: true })
  assert.ok(fs.readFileSync(blob, 'utf8').startsWith('enc:v1:'))
  assert.deepEqual(boot(dataDir, blob, 'read'), { enabled: true, plain: 'slot-token' })
})
