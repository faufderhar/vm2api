import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { callGrokKernel, grokKernelEnvelope } from '../../src/lib/transport/grok-kernel-client.mjs'
import { writeGrokKernelConfig } from '../../src/lib/transport/grok-kernel-supervisor.mjs'

test('the kernel envelope has no access token', () => {
  const envelope = grokKernelEnvelope({
    method: 'POST',
    path: '/v1/responses',
    body: { model: 'grok-4', input: 'hi' },
    stream: true,
    purpose: 'inference',
    sessionId: 'sess',
    modelId: 'grok-4',
    requestId: 'req',
    agentId: 'agent',
    access_token: 'secret',
  })
  assert.equal(JSON.stringify(envelope).includes('secret'), false)
  assert.equal(envelope.purpose, 'inference')
  assert.equal(envelope.session_id, 'sess')
})

test('a slot with no proxy is marked proxy_required and the config has no token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-kernel-'))
  const written = writeGrokKernelConfig(root, { id: 'vm-g' }, { proxyUrl: '', proxyRequired: true, routing: {} })
  const config = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(config.proxy_url, '')
  assert.equal(config.proxy_required, true)
  assert.equal(config.base_url, 'https://cli-chat-proxy.grok.com')
  // The kernel binary fixes the client version; the config only pins the platform.
  assert.equal('client_version' in config, false)
  assert.ok(config.platform.os && config.platform.arch)
  assert.equal(JSON.stringify(config).includes('access_token'), false)
  assert.ok(written.agentId)
  assert.equal(fs.readFileSync(written.agentIdPath, 'utf8').trim(), written.agentId)
})

test('a metadata or link-local proxy is refused before the kernel config is written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-kernel-'))
  assert.throws(
    () =>
      writeGrokKernelConfig(
        root,
        { id: 'vm-g' },
        { proxyUrl: 'socks5://169.254.169.254:1080', proxyRequired: true, routing: {} },
      ),
    (error) => error.code === 'proxy_host_blocked',
  )
  assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-g', 'run', 'grok-kernel.json')), false)
})

function fakeKernel(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-grok-kernel-call-'))
  const runDir = path.join(root, 'vms', 'vm-1', 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'grok-kernel.token'), 'token\n')
  const server = http.createServer(handler)
  t.after(() => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return new Promise((resolve) => server.listen(path.join(runDir, 'grok-kernel.sock'), () => resolve(root)))
}

test('a stream may run past timeoutMs once the kernel answered', async (t) => {
  const root = await fakeKernel(t, (req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let n = 0
    const timer = setInterval(() => {
      res.write(`data: ${n}\n\n`)
      n += 1
      if (n === 6) {
        clearInterval(timer)
        res.end()
      }
    }, 40)
  })
  const res = await callGrokKernel({ projectRoot: root, vmId: 'vm-1', envelope: {}, timeoutMs: 100 })
  let body = ''
  for await (const chunk of res) body += chunk
  assert.equal(body.match(/data:/g).length, 6)
})

test('a kernel that never answers still times out', async (t) => {
  const root = await fakeKernel(t, (req) => req.resume())
  await assert.rejects(callGrokKernel({ projectRoot: root, vmId: 'vm-1', envelope: {}, timeoutMs: 100 }), {
    code: 'grok_kernel_timeout',
  })
})
