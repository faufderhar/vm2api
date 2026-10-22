import test from 'node:test'
import assert from 'node:assert/strict'
import { applyIntercept } from '../../src/lib/core/intercept.mjs'

const rule = (set_body_field) => ({ phase: 'before_upstream', action: { set_body_field } })

test('set_body_field writes a nested path without touching the caller body', () => {
  const body = { metadata: { user_id: 'u1', tags: ['a'] }, model: 'm' }
  const out = applyIntercept([rule({ 'metadata.user_id': 'u2', 'extra.flag': true })], 'before_upstream', { body })
  assert.equal(out.body.metadata.user_id, 'u2')
  assert.equal(out.body.extra.flag, true)
  assert.deepEqual(out.body.metadata.tags, ['a'])
  assert.equal(body.metadata.user_id, 'u1')
  assert.equal(body.extra, undefined)
})

test('set_body_field ignores paths through __proto__, constructor or prototype', () => {
  const body = { model: 'm' }
  for (const key of ['__proto__.polluted', 'constructor.prototype.polluted', 'a.__proto__.polluted']) {
    applyIntercept([rule({ [key]: 'yes' })], 'before_upstream', { body })
  }
  assert.equal({}.polluted, undefined)
  assert.equal(Object.prototype.polluted, undefined)
})
