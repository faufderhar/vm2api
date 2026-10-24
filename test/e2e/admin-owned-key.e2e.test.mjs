import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

// A key an admin creates from a panel session carries that admin's user_id.
// Every /v1 route must read it as platform scope, not as the admin's own slots.
test('an admin-owned key reaches the platform pool on /v1/usage and count_tokens', async () => {
  const gw = await startGateway({ mockText: 'admin-owned' })
  try {
    const login = await api(gw, 'POST', '/api/panel/login', {
      headers: { authorization: '' },
      body: { username: 'admin', password: 'testpass' },
    })
    assert.equal(login.status, 200, login.text)
    assert.equal(login.json.token, undefined)
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0]
    assert.match(cookie, /^kin_panel_token=/)
    const session = { cookie, authorization: '' }
    const created = await api(gw, 'POST', '/api/panel/api-keys', { headers: session, body: { name: 'admin-owned' } })
    assert.equal(created.status, 201, created.text)
    assert.ok(created.json.item.user_id, 'a session-created key records its owner')
    const key = { authorization: `Bearer ${created.json.item.key}` }

    const usage = await api(gw, 'GET', '/v1/usage', { headers: key })
    assert.equal(usage.status, 200, usage.text)
    const counted = await api(gw, 'POST', '/v1/messages/count_tokens', {
      headers: key,
      body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    })
    // The slot hop needs a built kernel; account selection is what this test is about.
    assert.notEqual(counted.json?.error?.code, 'pool_unavailable', counted.text)
  } finally {
    await gw.stop()
  }
})
