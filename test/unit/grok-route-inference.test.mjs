import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGrokRouting, validateGrokRoutingPatch } from '../../src/lib/protocol/grok-route.mjs'

test('Grok inference idle timeout defaults to the official hour and stays in range', () => {
  assert.equal(normalizeGrokRouting({}).inference.idle_timeout_sec, 3600)
  assert.equal(normalizeGrokRouting({ inference: { idle_timeout_sec: 600 } }).inference.idle_timeout_sec, 600)
  assert.equal(normalizeGrokRouting({ inference: { idle_timeout_sec: 5 } }).inference.idle_timeout_sec, 30)
  assert.equal(normalizeGrokRouting({ inference: { idle_timeout_sec: 99999 } }).inference.idle_timeout_sec, 7200)
  assert.doesNotThrow(() => validateGrokRoutingPatch({ grok: { inference: { idle_timeout_sec: 900 } } }))
  assert.throws(() => validateGrokRoutingPatch({ grok: { inference: { idle_timeout_sec: 1.5 } } }), /idle_timeout_sec/)
  assert.throws(() => validateGrokRoutingPatch({ grok: { inference: 'x' } }), /grok\.inference/)
})
