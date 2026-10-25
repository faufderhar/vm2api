import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'
import { guardUpgrade, safeDecodeURIComponent } from '../../src/lib/core/upgrade-guard.mjs'

const UPGRADE_HEADERS =
  'Host: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'

async function listen(onUpgrade) {
  const server = http.createServer((_req, res) => res.end())
  server.on('upgrade', onUpgrade)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

/** Send a raw upgrade request; resolve with the bytes received and whether the server closed. */
function rawUpgrade(port, pathname, waitMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    let data = ''
    let closed = false
    const timer = setTimeout(() => {
      sock.destroy()
      resolve({ data, closed })
    }, waitMs)
    sock.on('data', (d) => (data += d.toString()))
    sock.on('close', () => {
      closed = true
      clearTimeout(timer)
      resolve({ data, closed })
    })
    sock.on('error', () => {})
    sock.once('connect', () => sock.write(`GET ${pathname} HTTP/1.1\r\n${UPGRADE_HEADERS}`))
  })
}

test('M-1: malformed percent-encoding on the slot shell path answers 400 and closes the socket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-uri-'))
  const shell = createSlotShell({ projectRoot: root, logger: { warn() {} } })
  const uncaught = []
  const onUncaught = (e) => uncaught.push(e)
  process.on('uncaughtException', onUncaught)
  const server = await listen((req, socket, head) => {
    if (!shell.handleUpgrade(req, socket, head)) socket.destroy()
  })
  try {
    const r = await rawUpgrade(server.address().port, '/api/panel/vms/%E0%A4%A/shell')
    assert.equal(r.closed, true, 'server must close the socket')
    assert.match(r.data, /^HTTP\/1\.1 400 /)
    assert.equal(uncaught.length, 0)
  } finally {
    process.off('uncaughtException', onUncaught)
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('M-1: guardUpgrade destroys the socket when a handler throws, and on unclaimed upgrades', async () => {
  const warnings = []
  const onUpgrade = guardUpgrade(
    [
      (req) => {
        if (req.url === '/boom') throw new URIError('URI malformed')
        if (req.url === '/crash') throw new Error('internal detail')
        return false
      },
    ],
    { logger: { warn: (m) => warnings.push(m) } },
  )
  const server = await listen(onUpgrade)
  const { port } = server.address()
  try {
    const bad = await rawUpgrade(port, '/boom')
    assert.equal(bad.closed, true)
    assert.match(bad.data, /^HTTP\/1\.1 400 /)
    const crash = await rawUpgrade(port, '/crash')
    assert.equal(crash.closed, true)
    assert.match(crash.data, /^HTTP\/1\.1 500 /)
    assert.doesNotMatch(crash.data, /internal detail/)
    const none = await rawUpgrade(port, '/nobody')
    assert.equal(none.closed, true)
    assert.equal(warnings.length, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('safeDecodeURIComponent returns null instead of throwing', () => {
  assert.equal(safeDecodeURIComponent('%E0%A4%A'), null)
  assert.equal(safeDecodeURIComponent('vm-01'), 'vm-01')
  assert.equal(safeDecodeURIComponent('vm%2D01'), 'vm-01')
})
