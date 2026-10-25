import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { startGateway } from '../harness.mjs'

function get(gw, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(gw.baseUrl + urlPath, { method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function wsHandshake(gw, headers) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(gw.port, '127.0.0.1', () => {
      const lines = [
        'GET /v1/responses HTTP/1.1',
        `Host: 127.0.0.1:${gw.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ]
      sock.write(lines.join('\r\n'))
    })
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\r\n')) {
        sock.destroy()
        resolve(Number(buf.split(' ')[1]))
      }
    })
    sock.on('error', reject)
    sock.setTimeout(5000, () => {
      sock.destroy()
      reject(new Error('ws handshake timeout'))
    })
  })
}

test('a panel cookie cannot drive inference or the Responses WebSocket cross-site', async () => {
  const gw = await startGateway()
  try {
    const login = await fetch(gw.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'testpass' }),
    })
    assert.equal(login.status, 200, await login.clone().text())
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    assert.match(cookie, /^kin_panel_token=/)

    // Cross-site browser requests with only the ambient cookie are refused.
    const evil = await get(gw, '/v1/models', { cookie, origin: 'https://evil.example' })
    assert.equal(evil.status, 403, evil.body)
    assert.match(evil.body, /cross_site_request/)
    const fetchSite = await get(gw, '/v1/models', { cookie, 'sec-fetch-site': 'cross-site' })
    assert.equal(fetchSite.status, 403, fetchSite.body)
    const sameSite = await get(gw, '/v1/models', { cookie, 'sec-fetch-site': 'same-site' })
    assert.equal(sameSite.status, 403, sameSite.body)

    // Same-origin panel use keeps working.
    const same = await get(gw, '/v1/meta', { cookie, origin: gw.baseUrl })
    assert.equal(same.status, 200, same.body)
    const plain = await get(gw, '/v1/meta', { cookie })
    assert.equal(plain.status, 200, plain.body)

    // An explicit API key is unchanged and wins over the cookie.
    const keyed = await get(gw, '/v1/meta', {
      cookie,
      origin: 'https://evil.example',
      authorization: `Bearer ${gw.apiKey}`,
    })
    assert.equal(keyed.status, 200, keyed.body)
    const badKey = await get(gw, '/v1/meta', { cookie, 'x-api-key': 'sk-vm-not-a-real-key-000000' })
    assert.equal(badKey.status, 401, badKey.body)

    // The panel itself is still guarded only by its existing write check.
    const panelGet = await get(gw, '/api/panel/me', { cookie, 'sec-fetch-site': 'cross-site' })
    assert.notEqual(panelGet.status, 403, panelGet.body)

    // Cross-site WebSocket hijacking is refused; same-origin upgrade still authenticates.
    assert.equal(await wsHandshake(gw, { Cookie: cookie, Origin: 'https://evil.example' }), 403)
    // M-2: a panel session is not an API key — even same-origin it cannot open
    // the metered Responses WebSocket or POST inference (no quota/billing).
    assert.equal(await wsHandshake(gw, { Cookie: cookie, Origin: gw.baseUrl }), 403)
    const token = cookie.split('=')[1]
    for (const headers of [{ cookie }, { 'x-panel-token': token }, { authorization: `Bearer ${token}` }]) {
      const r = await fetch(gw.baseUrl + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      })
      const text = await r.text()
      assert.equal(r.status, 403, text)
      assert.match(text, /panel_session_not_api_key/)
    }
    const models = await get(gw, '/v1/models', { cookie })
    assert.equal(models.status, 200, models.body)
    assert.equal(await wsHandshake(gw, { Authorization: `Bearer ${gw.apiKey}`, Origin: 'https://evil.example' }), 101)
  } finally {
    await gw.stop()
  }
})
