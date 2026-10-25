import test from 'node:test'
import assert from 'node:assert/strict'
import { originMatchesRequestHost, panelCookieUseAllowed, panelCookieWriteAllowed } from '../../src/lib/core/security.mjs'

const req = (host, extra = {}) => ({ method: 'POST', headers: { host, cookie: 'kin_panel_token=kin-panel-x', ...extra } })

test('L-2: same hostname on another port is a different origin', () => {
  assert.equal(originMatchesRequestHost('http://gw.example:8787', req('gw.example:8787'), {}), true)
  assert.equal(originMatchesRequestHost('http://gw.example:8080', req('gw.example:8787'), {}), false)
  assert.equal(originMatchesRequestHost('https://gw.example', req('gw.example'), {}), true)
  assert.equal(originMatchesRequestHost('https://gw.example:443', req('gw.example:443'), {}), true)
  assert.equal(originMatchesRequestHost('http://gw.example', req('gw.example:80'), {}), true)
  assert.equal(originMatchesRequestHost('https://gw.example:8443', req('gw.example'), {}), false)
  assert.equal(originMatchesRequestHost('http://other.example:8787', req('gw.example:8787'), {}), false)
  assert.equal(originMatchesRequestHost('ftp://gw.example:8787', req('gw.example:8787'), {}), false)
})

test('L-2: behind a trusted proxy that strips the port, the hostname is enough', () => {
  assert.equal(originMatchesRequestHost('https://gw.example:8443', req('gw.example'), { TRUST_PROXY: '1' }), true)
  // An explicit port is still compared.
  assert.equal(originMatchesRequestHost('https://gw.example:8443', req('gw.example:443'), { TRUST_PROXY: '1' }), false)
})

test('L-2: cookie checks refuse a same-host different-port origin unless allowlisted', () => {
  const evil = req('gw.example:8787', { origin: 'http://gw.example:9000' })
  assert.equal(panelCookieWriteAllowed(evil, new Set()), false)
  assert.equal(panelCookieUseAllowed(evil, new Set()), false)
  assert.equal(panelCookieWriteAllowed(evil, new Set(['http://gw.example:9000'])), true)
  const same = req('gw.example:8787', { origin: 'http://gw.example:8787' })
  assert.equal(panelCookieWriteAllowed(same, new Set()), true)
  assert.equal(panelCookieUseAllowed(same, new Set()), true)
})
