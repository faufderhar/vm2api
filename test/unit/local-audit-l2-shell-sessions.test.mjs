import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('L2: a client that leaves during the login check does not leak a shell session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-leak-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-02', 'cli-home', '.kin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02' }))
  fs.writeFileSync(path.join(root, 'vms', 'vm-02', 'cli-home', '.kin', 'cli-node'), '')
  const shell = createSlotShell({
    projectRoot: root,
    logger: { warn() {} },
    authLoginReady: async () => ({ container: 'kin-02', cli: '/opt/kin/cli-node' }),
    upgradeLoginReady: () => delay(80),
  })
  const server = http.createServer((_req, res) => res.end())
  server.on('upgrade', (req, socket, head) => shell.handleUpgrade(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    for (let i = 0; i < 10; i++) {
      const t = await shell.issueTicket('vm-02', { login: true })
      assert.equal(t.ok, true, `ticket ${i}: ${JSON.stringify(t.error)}`)
      const sock = net.connect(port, '127.0.0.1')
      await new Promise((resolve) => sock.once('connect', resolve))
      sock.write(
        `GET /api/panel/vms/vm-02/shell?ticket=${t.ticket}&login=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      )
      await delay(20)
      sock.destroy()
      await delay(120)
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
