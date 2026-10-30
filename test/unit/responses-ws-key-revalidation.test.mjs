import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createResponsesWsHandler } from '../../src/lib/protocol/responses-ws.mjs'

// H-1 (DEEP_AUDIT_2026-10-30): a Responses WebSocket used to admit every turn against the
// key record captured at the upgrade. Each turn now re-runs the gateway's auth gate.

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function tmpStore() {
  return new ApiKeyStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ws-reauth-')) })
}

/** The managed-key branch of server.mjs requireAuth: authenticate, then the pre-flight gate. */
function managedAuth(store, calls) {
  return (req, res) => {
    calls.n++
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const managed = store.authenticate(token)
    if (!managed.ok) {
      json(res, 401, {
        error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid credentials' },
      })
      return false
    }
    const gate = store.canAccept(managed.record)
    if (!gate.ok) {
      json(res, gate.status, { error: { type: 'permission_error', code: gate.code, message: gate.message } })
      return false
    }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = managed.record
    return true
  }
}

/** Stand-in for handleProtocol's withManagedKey: acquire, answer, charge, release. */
function billingProtocol(store, hops) {
  return async (req, res) => {
    const gate = store.acquire(req.apiKeyRecord)
    if (!gate.ok) return json(res, gate.status, { error: { code: gate.code, message: gate.message } })
    hops.push(req.apiKeyRecord.quota_requests_used)
    try {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const id = `resp_${hops.length}`
      res.end(`data: {"type":"response.completed","response":{"id":"${id}","status":"completed","output":[]}}\n\n`)
      store.recordUsage(req.apiKeyRecord, { input_tokens: 3, output_tokens: 2 }, { officialCost: 0 })
    } finally {
      store.release(req.apiKeyRecord)
    }
  }
}

async function listen(store, hops, calls) {
  const handler = createResponsesWsHandler({
    handleProtocol: billingProtocol(store, hops),
    requireAuth: managedAuth(store, calls),
    json,
    getRouting: () => ({ websocket: { enabled: true } }),
  })
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `ws://127.0.0.1:${server.address().port}/v1/responses`,
    close: () =>
      new Promise((resolve) => {
        for (const client of handler.wss.clients) client.terminate()
        server.close(resolve)
        server.closeAllConnections?.()
      }),
  }
}

function open(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function frame(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs)
    const onMessage = (data) => {
      const parsed = JSON.parse(String(data))
      if (!predicate(parsed)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(parsed)
    }
    ws.on('message', onMessage)
  })
}

const turn = (ws, input) => ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input }))

test('a used-up request quota stops the next WebSocket turn, the socket stays open', async () => {
  const store = tmpStore()
  const created = store.create({ name: 'ws-quota', quota_requests: 2 })
  const hops = []
  const calls = { n: 0 }
  const live = await listen(store, hops, calls)
  const ws = await open(live.url, created.key)
  try {
    for (const input of ['one', 'two']) {
      const done = frame(ws, (f) => f.type === 'response.completed')
      turn(ws, input)
      await done
    }
    // Each turn saw the key's current counter, not the upgrade-time one.
    assert.deepEqual(hops, [0, 1])
    const refused = frame(ws, (f) => f.type === 'error')
    turn(ws, 'three')
    const err = await refused
    assert.equal(err.error.code, 'api_key_quota_exhausted')
    assert.equal(hops.length, 2)
    assert.equal(ws.readyState, WebSocket.OPEN)
    assert.equal(store.getById(created.id).quota_requests_used, 2)
    // handshake + three turns
    assert.equal(calls.n, 4)
  } finally {
    ws.terminate()
    await live.close()
  }
})

for (const [label, revoke, code] of [
  ['disabled', (store, id) => store.update(id, { status: 'disabled' }), 'api_key_disabled'],
  ['deleted', (store, id) => store.remove(id), 'invalid_api_key'],
  [
    'expired',
    (store, id) => store.update(id, { expires_at: new Date(Date.now() - 1000).toISOString() }),
    'api_key_expired',
  ],
]) {
  test(`a key ${label} after the upgrade is refused on the next turn and the socket closes`, async () => {
    const store = tmpStore()
    const created = store.create({ name: `ws-${label}` })
    const hops = []
    const live = await listen(store, hops, { n: 0 })
    const ws = await open(live.url, created.key)
    try {
      const done = frame(ws, (f) => f.type === 'response.completed')
      turn(ws, 'before')
      await done
      revoke(store, created.id)
      const refused = frame(ws, (f) => f.type === 'error')
      const closed = new Promise((resolve) => ws.once('close', (codeNum) => resolve(codeNum)))
      turn(ws, 'after')
      assert.equal((await refused).error.code, code)
      assert.equal(await closed, 1008)
      assert.equal(hops.length, 1)
    } finally {
      ws.terminate()
      await live.close()
    }
  })
}

test('a turn admitted before the key was disabled is still charged to it', () => {
  const store = tmpStore()
  const created = store.create({ name: 'mid-flight', quota: 10 })
  const rec = store.authenticate(created.key).record
  assert.equal(store.acquire(rec).ok, true)
  store.update(created.id, { status: 'disabled' })
  const charged = store.recordUsage(rec, { input_tokens: 5, output_tokens: 5 }, { officialCost: 1.5 })
  store.release(rec)
  assert.ok(charged)
  assert.equal(charged.requests, 1)
  assert.equal(charged.quota_used, 1.5)
  assert.equal(charged.status, 'disabled')
})
