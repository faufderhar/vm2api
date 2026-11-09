import test from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'

const proxyPool = { snapshot: () => ({ proxies: [], config: { ipv6_enabled: false } }), getProxyForVm: () => null }
const { requireSlotProxy } = createImportCommit({ proxyPool, routingConfig: {} })
const body = { proxy_url: 'socks5://user:pass@proxy.example.com:1080' }

test('an override that resolves to internal space is refused', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '10.0.0.5', family: 4 }])
  const out = await requireSlotProxy({ id: 'vm-1' }, body)
  assert.equal(out.ok, false)
  assert.equal(out.status, 400)
  assert.equal(out.resolved.reason, 'proxy_host_blocked')
})

test('an override is dialled at the address that was checked', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.10', family: 4 }])
  const out = await requireSlotProxy({ id: 'vm-1' }, body)
  assert.equal(out.ok, true)
  assert.match(out.proxyUrl, /203\.0\.113\.10:1080/)
  assert.match(out.proxyUrl, /user:pass@/)
})

test('a name that does not resolve is refused', async (t) => {
  t.mock.method(dns, 'lookup', async () => {
    throw new Error('ENOTFOUND')
  })
  assert.equal((await requireSlotProxy({ id: 'vm-1' }, body)).ok, false)
})
