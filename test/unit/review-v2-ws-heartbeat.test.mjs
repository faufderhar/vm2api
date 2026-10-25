import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { startWsHeartbeat, wsHeartbeatMs } from '../../src/lib/core/ws-heartbeat.mjs'
import { createClusterRoutes } from '../../src/lib/cluster/cluster-routes.mjs'

class FakeWs extends EventEmitter {
  pings = 0
  terminated = false
  ping() {
    this.pings += 1
  }
  terminate() {
    this.terminated = true
    this.emit('close')
  }
}

test('L-8: heartbeat terminates a peer that misses a pong and keeps one that answers', async () => {
  const silent = new FakeWs()
  startWsHeartbeat(silent, 20)
  const live = new FakeWs()
  live.ping = function () {
    this.pings += 1
    setImmediate(() => this.emit('pong'))
  }
  const stopLive = startWsHeartbeat(live, 20)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(silent.terminated, true)
  assert.equal(live.terminated, false)
  assert.ok(live.pings >= 3)
  stopLive()
  const before = live.pings
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(live.pings, before, 'stop clears the timer')
})

test('L-8: VM2API_WS_HEARTBEAT_MS parsing', () => {
  assert.equal(wsHeartbeatMs({}), 30_000)
  assert.equal(wsHeartbeatMs({ VM2API_WS_HEARTBEAT_MS: '0' }), 0)
  assert.equal(wsHeartbeatMs({ VM2API_WS_HEARTBEAT_MS: '10' }), 1000)
  assert.equal(wsHeartbeatMs({ VM2API_WS_HEARTBEAT_MS: 'x' }), 30_000)
  assert.equal(wsHeartbeatMs({ VM2API_WS_HEARTBEAT_MS: '45000' }), 45_000)
})

test('L-8: a half-open cluster shell client is dropped and its SSH stream closed', async () => {
  const stream = new EventEmitter()
  let streamClosed = false
  stream.write = () => {}
  stream.setWindow = () => {}
  stream.close = () => {
    streamClosed = true
  }
  const manager = { consumeShellTicket: () => true, openShell: async () => stream }
  const routes = createClusterRoutes({ manager, json() {}, readBody() {}, ok: (x) => x, heartbeatMs: 50 })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    if (!routes.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  // Raw client: completes the handshake, then never answers pings (half-open peer).
  const sock = net.connect(server.address().port, '127.0.0.1')
  const key = crypto.randomBytes(16).toString('base64')
  sock.write(
    `GET /api/panel/cluster/nodes/node-a/shell HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vm2api-ticket.t1\r\n\r\n`,
  )
  let data = ''
  sock.on('data', (c) => (data += c.toString('latin1')))
  const closed = new Promise((r) => sock.on('close', r))
  const outcome = await Promise.race([
    closed.then(() => 'closed'),
    new Promise((r) => setTimeout(() => r('timeout'), 3000)),
  ])
  for (let i = 0; i < 50 && !streamClosed; i++) await new Promise((r) => setTimeout(r, 20))
  server.close()
  sock.destroy()
  assert.match(data, /^HTTP\/1\.1 101/)
  assert.equal(outcome, 'closed')
  assert.equal(streamClosed, true)
})
