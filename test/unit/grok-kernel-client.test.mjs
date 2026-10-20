import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { grokKernelEnvelope } from '../../src/lib/transport/grok-kernel-client.mjs'
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
  assert.equal(config.client_version, '1.0.62')
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
