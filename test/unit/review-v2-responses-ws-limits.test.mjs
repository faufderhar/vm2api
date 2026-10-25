import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createResponsesWsHandler } from '../../src/lib/protocol/responses-ws.mjs'

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function listen(opts) {
  const handler = createResponsesWsHandler({
    handleProtocol: async () => {},
    requireAuth: (req) => {
      const id = req.headers['x-test-key']
      if (id) req.apiKeyRecord = { id }
      return true
    },
    json,
    getRouting: () => ({}),
    heartbeatMs: 0,
    clientAddress: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress,
    ...opts,
  })
  const server = http.createServer((_req, res) => res.end())
  server.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { handler, url: `ws://127.0.0.1:${server.address().port}/v1/responses`, server }
}

function open(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.once('open', () => resolve({ ok: true, ws }))
    ws.once('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ ok: false, status: res.statusCode, body: JSON.parse(body || '{}') }))
    })
    ws.once('error', () => resolve({ ok: false, status: 0 }))
  })
}

test('L-9: per-address cap on open Responses WebSockets, released on close', async (t) => {
  const { url, server, handler } = await listen({ maxPerIp: 2, maxPerKey: 0 })
  t.after(() => server.close())
  const h = { 'x-test-ip': '203.0.113.5' }
  const a = await open(url, h)
  const b = await open(url, h)
  assert.equal(a.ok && b.ok, true)
  const c = await open(url, h)
  assert.equal(c.status, 429)
  assert.equal(c.body.error.code, 'websocket_limit')
  // Another address is unaffected.
  const d = await open(url, { 'x-test-ip': '203.0.113.6' })
  assert.equal(d.ok, true)
  a.ws.close()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(handler.openConnections().byIp.get('203.0.113.5'), 1)
  const e = await open(url, h)
  assert.equal(e.ok, true)
  for (const x of [b, d, e]) x.ws.terminate()
})

test('L-9: per-key cap applies across addresses; loopback peers only get the key cap', async (t) => {
  const { url, server } = await listen({ maxPerIp: 1, maxPerKey: 2 })
  t.after(() => server.close())
  const k = (ip) => ({ 'x-test-key': 'k1', ...(ip ? { 'x-test-ip': ip } : {}) })
  // Loopback (no x-test-ip): the per-IP cap of 1 does not apply.
  const a = await open(url, k())
  const b = await open(url, k())
  assert.equal(a.ok && b.ok, true)
  const c = await open(url, k('198.51.100.9'))
  assert.equal(c.status, 429)
  assert.match(c.body.error.message, /API key/)
  const other = await open(url, { 'x-test-key': 'k2' })
  assert.equal(other.ok, true)
  for (const x of [a, b, other]) x.ws.terminate()
})
