import test from 'node:test'
import assert from 'node:assert/strict'
import { decryptString, encryptString } from '../../src/lib/db/secure.mjs'

const SECRET = 'unit-test-secret'

test('encrypted values round-trip', () => {
  const sealed = encryptString('sk-ant-oat01-value', SECRET)
  assert.match(sealed, /^enc:v1:/)
  assert.equal(decryptString(sealed, SECRET), 'sk-ant-oat01-value')
})

test('a value with a truncated authentication tag is refused', () => {
  const [iv, tag, ct] = encryptString('secret', SECRET).slice('enc:v1:'.length).split(':')
  const short = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64')
  assert.throws(() => decryptString(`enc:v1:${iv}:${short}:${ct}`, SECRET), /authentication tag/)
  assert.throws(() => decryptString(`enc:v1:${iv}::${ct}`, SECRET), /authentication tag/)
})
