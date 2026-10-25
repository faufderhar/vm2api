import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createResponsesWsHandler } from '../../src/lib/protocol/responses-ws.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function listen(heartbeatMs) {
  const handler = createResponsesWsHandler({
    handleProtocol: async () => {},
    requireAuth: () => true,
    json: () => {},
    getRouting: () => ({}),
    heartbeatMs,
  })
  const server = http.createServer((_req, res) => res.end())
  server.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `ws://127.0.0.1:${server.address().port}/v1/responses` }
}

async function connect(url, opts) {
  const ws = new WebSocket(url, opts)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let closed = false
  ws.on('close', () => {
    closed = true
  })
  return { ws, isClosed: () => closed }
}

test('L3: a peer that never answers ping is dropped; a live peer stays connected', async () => {
  const { server, url } = await listen(40)
  try {
    const dead = await connect(url, { autoPong: false })
    const live = await connect(url)
    await delay(300)
    assert.equal(dead.isClosed(), true, 'peer without pong should be terminated')
    assert.equal(live.isClosed(), false, 'peer answering ping should stay open')
    live.ws.close()
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})
