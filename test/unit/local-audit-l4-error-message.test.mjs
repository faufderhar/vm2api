import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicErrorMessage } from '../../src/lib/core/security.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('L4: unexpected errors do not leak their text to the client', () => {
  assert.equal(publicErrorMessage(new Error('SQLITE_ERROR near "x": /app/data/kin.db')), 'internal server error')
  assert.equal(publicErrorMessage('boom /etc/passwd'), 'internal server error')
  assert.equal(publicErrorMessage(null), 'internal server error')
})

test('L4: errors raised with an explicit status keep their message', () => {
  assert.equal(
    publicErrorMessage(Object.assign(new Error('request body too large'), { status: 413 })),
    'request body too large',
  )
  assert.equal(
    publicErrorMessage(Object.assign(new Error('upstream unavailable'), { status: 503 })),
    'upstream unavailable',
  )
})

test('L4: the server catch-all uses publicErrorMessage', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'server.mjs'), 'utf8')
  assert.match(src, /message: publicErrorMessage\(e\), type: 'server_error'/)
  assert.doesNotMatch(src, /message: e\.message \|\| String\(e\), type: 'server_error'/)
})
