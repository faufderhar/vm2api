import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function newer(version, floor) {
  const a = version.split('.').map(Number)
  const b = floor.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

test('M3: the locked ip-address is past GHSA-rxp7-6hxx-x8q5 (<=10.7.3)', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const entries = Object.entries(lock.packages || {}).filter(([k]) => k.endsWith('node_modules/ip-address'))
  assert.ok(entries.length, 'ip-address is in the lockfile')
  for (const [k, v] of entries) assert.ok(newer(v.version, '10.7.3'), `${k}@${v.version}`)
})
