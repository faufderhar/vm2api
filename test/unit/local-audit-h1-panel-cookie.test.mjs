import test from 'node:test'
import assert from 'node:assert/strict'
import { panelCookieUseAllowed, panelTokenFromCookie } from '../../src/lib/core/security.mjs'

test('H1: a panel token counts as cookie-borne only when no header carries one', () => {
  assert.equal(panelTokenFromCookie({ headers: { cookie: 'kin_panel_token=kin-panel-a' } }), true)
  assert.equal(panelTokenFromCookie({ headers: { cookie: 'kin_console_token=kin-panel-a' } }), true)
  assert.equal(
    panelTokenFromCookie({ headers: { cookie: 'kin_panel_token=x', authorization: 'Bearer kin-panel-b' } }),
    false,
  )
  assert.equal(
    panelTokenFromCookie({ headers: { cookie: 'kin_panel_token=x', 'x-panel-token': 'kin-panel-b' } }),
    false,
  )
  assert.equal(panelTokenFromCookie({ headers: { authorization: 'Bearer sk-vm-abc' } }), false)
  assert.equal(panelTokenFromCookie({ headers: {} }), false)
})

test('H1: a panel cookie outside the panel needs this host or an allowlisted origin, on any method', () => {
  const req = (headers, method = 'GET') => ({ method, headers: { host: 'gw.example:8787', ...headers } })
  // WebSocket upgrades are GETs: the method does not exempt them.
  assert.equal(panelCookieUseAllowed(req({ origin: 'https://evil.example' }), []), false)
  assert.equal(panelCookieUseAllowed(req({ origin: 'https://evil.example' }, 'POST'), []), false)
  assert.equal(panelCookieUseAllowed(req({ 'sec-fetch-site': 'cross-site' }), []), false)
  assert.equal(panelCookieUseAllowed(req({ 'sec-fetch-site': 'same-site' }), []), false)
  assert.equal(panelCookieUseAllowed(req({ origin: 'http://gw.example:8787' }), []), true)
  assert.equal(panelCookieUseAllowed(req({ origin: 'https://panel.example' }), ['https://panel.example']), true)
  assert.equal(panelCookieUseAllowed(req({ 'sec-fetch-site': 'same-origin' }), []), true)
  // Not a browser: nothing to forge cross-site.
  assert.equal(panelCookieUseAllowed(req({}), []), true)
})
