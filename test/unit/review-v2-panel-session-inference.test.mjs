import test from 'node:test'
import assert from 'node:assert/strict'
import { isProtocolPath, panelSessionProtocolBlock } from '../../src/lib/core/security.mjs'

test('M-2: panel sessions are refused on metered protocol routes for every role', () => {
  for (const role of ['user', 'super', 'admin', '']) {
    for (const [method, pathname] of [
      ['POST', '/v1/messages'],
      ['POST', '/v1/chat/completions'],
      ['POST', '/v1/responses'],
      ['GET', '/v1/responses'],
      ['POST', '/v1/messages/count_tokens'],
      ['POST', '/messages'],
      ['POST', '/chat/completions'],
      ['POST', '/v1/images/generations'],
      ['POST', '/v1/models'],
    ]) {
      const block = panelSessionProtocolBlock({ pathname, method, role }, {})
      assert.equal(block?.code, 'panel_session_not_api_key', `${role} ${method} ${pathname}`)
    }
  }
})

test('M-2: read-only gateway routes and panel routes stay open to sessions', () => {
  for (const pathname of ['/v1/meta', '/v1/models', '/v1/usage']) {
    assert.equal(panelSessionProtocolBlock({ pathname, method: 'GET', role: 'user' }, {}), null)
  }
  assert.equal(panelSessionProtocolBlock({ pathname: '/api/panel/me', method: 'POST', role: 'user' }, {}), null)
  assert.equal(panelSessionProtocolBlock({ pathname: '/admin/models/refresh', method: 'POST', role: 'admin' }, {}), null)
})

test('M-2: VM2API_PANEL_SESSION_INFERENCE=admin re-allows admin only, never super or tenants', () => {
  const env = { VM2API_PANEL_SESSION_INFERENCE: 'admin' }
  assert.equal(panelSessionProtocolBlock({ pathname: '/v1/messages', method: 'POST', role: 'admin' }, env), null)
  assert.ok(panelSessionProtocolBlock({ pathname: '/v1/messages', method: 'POST', role: 'super' }, env))
  assert.ok(panelSessionProtocolBlock({ pathname: '/v1/messages', method: 'POST', role: 'user' }, env))
  assert.ok(
    panelSessionProtocolBlock(
      { pathname: '/v1/messages', method: 'POST', role: 'admin' },
      { VM2API_PANEL_SESSION_INFERENCE: '1' },
    ),
  )
})

test('isProtocolPath works on normalized pathnames', () => {
  assert.equal(isProtocolPath('/v1/chat/completions'), true)
  assert.equal(isProtocolPath('/responses'), true)
  assert.equal(isProtocolPath('/api/panel/v1'), false)
  assert.equal(isProtocolPath('/v1x'), false)
})
