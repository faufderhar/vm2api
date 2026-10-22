import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Production default: private proxies stay blocked for tenant SOCKS.
delete process.env.VM2API_ALLOW_PRIVATE_PROXY

const { assertProxyAllowed, isUnsafeProxyHost, registerPlatformEgressEndpoint } = await import(
  '../../src/lib/vm/proxy-policy.mjs'
)
const { nodeEgressProxyUrl, startNodeEgressSocks, stopNodeEgressSocks } = await import(
  '../../src/lib/cluster/node-egress-socks.mjs'
)
const { writeGrokKernelConfig } = await import('../../src/lib/transport/grok-kernel-supervisor.mjs')

test('a tenant SOCKS on loopback or RFC1918 is still blocked', () => {
  assert.equal(isUnsafeProxyHost({ url: 'socks5h://127.0.0.1:1080' }), true)
  assert.equal(isUnsafeProxyHost({ url: 'socks5://10.0.0.5:1080' }), true)
  assert.throws(() => assertProxyAllowed({ url: 'socks5://172.18.0.3:1080' }), { code: 'proxy_host_blocked' })
})

test('the node egress front is the platform route while it listens', async (t) => {
  t.after(() => stopNodeEgressSocks())
  await startNodeEgressSocks({
    clientFor: () => {
      throw new Error('not used')
    },
  })
  const url = nodeEgressProxyUrl('node-1')
  assert.match(url, /@127\.0\.0\.1:\d+$/)
  assert.doesNotThrow(() => assertProxyAllowed({ url }))
  // Another loopback port is not the front.
  const port = Number(new URL(url).port)
  assert.equal(isUnsafeProxyHost({ url: `socks5h://127.0.0.1:${port === 65535 ? 65534 : port + 1}` }), true)
  await stopNodeEgressSocks()
  assert.equal(isUnsafeProxyHost({ url }), true)
})

test('a Grok node slot on local egress writes its kernel config', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-grok-node-egress-'))
  t.after(async () => {
    await stopNodeEgressSocks()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await startNodeEgressSocks({
    clientFor: () => {
      throw new Error('not used')
    },
  })
  const proxyUrl = nodeEgressProxyUrl('node-1')
  const written = writeGrokKernelConfig(root, { id: 'vm-grok', node_id: 'node-1' }, { proxyUrl })
  const config = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(config.proxy_url, proxyUrl)
})

test('the deployment proxy env is the platform route', () => {
  const previous = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'socks5://127.0.0.1:7890'
  try {
    assert.doesNotThrow(() => assertProxyAllowed({ url: 'socks5h://127.0.0.1:7890' }))
    assert.equal(isUnsafeProxyHost({ url: 'socks5h://127.0.0.1:7891' }), true)
  } finally {
    if (previous == null) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previous
  }
})

test('unregistering an endpoint blocks it again', () => {
  const release = registerPlatformEgressEndpoint('127.0.0.1', 40001)
  assert.equal(isUnsafeProxyHost({ url: 'socks5h://u:p@127.0.0.1:40001' }), false)
  release()
  assert.equal(isUnsafeProxyHost({ url: 'socks5h://u:p@127.0.0.1:40001' }), true)
})
