import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { proxyWriteBlockReason, resolvedProxyDial } from '../../src/lib/vm/proxy-policy.mjs'

const ANSWERS = {
  'evil-loopback.example': ['127.0.0.1'],
  'evil-metadata.example': ['169.254.169.254'],
  'evil-mixed.example': ['93.184.216.34', '10.0.0.5'],
  'good.example': ['93.184.216.34'],
}
const lookup = async (name) => {
  const list = ANSWERS[name]
  if (!list) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

function withStrictPolicy(t) {
  const prev = process.env.VM2API_ALLOW_PRIVATE_PROXY
  delete process.env.VM2API_ALLOW_PRIVATE_PROXY
  t.after(() => {
    if (prev == null) delete process.env.VM2API_ALLOW_PRIVATE_PROXY
    else process.env.VM2API_ALLOW_PRIVATE_PROXY = prev
  })
}

function newPool() {
  const pool = new ProxyPool({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-px-m3-')) })
  pool.stopScheduler()
  pool.dnsLookup = lookup
  return pool
}

test('M-3: import skips names that resolve to private, loopback or metadata addresses', async (t) => {
  withStrictPolicy(t)
  const pool = newPool()
  const r = await pool.importLinesChecked(
    [
      'evil-loopback.example:1080',
      'evil-metadata.example:1080',
      'evil-mixed.example:1080',
      'nxdomain.example:1080',
      'good.example:1080',
      '8.8.8.8:1080',
    ].join('\n'),
  )
  assert.equal(r.added, 2)
  assert.deepEqual(
    pool.state.proxies.map((p) => p.host),
    ['good.example', '8.8.8.8'],
  )
  const reasons = Object.fromEntries(r.skip_details.map((d) => [d.line.split(':')[0], d.reason]))
  assert.equal(reasons['evil-loopback.example'], 'proxy_host_blocked')
  assert.equal(reasons['evil-metadata.example'], 'proxy_host_blocked')
  assert.equal(reasons['evil-mixed.example'], 'proxy_host_blocked')
  assert.equal(reasons['nxdomain.example'], 'proxy_host_unresolvable')
})

test('M-3: structured fields go through the same check, literal rule still applies', async (t) => {
  withStrictPolicy(t)
  const pool = newPool()
  const r = await pool.importLinesChecked('', {
    fields: [
      { host: 'evil-loopback.example', port: 1080 },
      { host: '127.0.0.1', port: 1080 },
    ],
  })
  assert.equal(r.added, 0)
  assert.equal(r.skipped, 2)
})

test('M-3: ensureSocksChecked (VM package import) refuses a name resolving to loopback', async (t) => {
  withStrictPolicy(t)
  const pool = newPool()
  const bad = await pool.ensureSocksChecked({ host: 'evil-loopback.example', port: 1080 })
  assert.deepEqual(bad, { ok: false, error: 'proxy_host_blocked' })
  assert.equal(pool.state.proxies.length, 0)
  const good = await pool.ensureSocksChecked({ host: 'good.example', port: 1080 })
  assert.equal(good.ok, true)
  assert.equal(good.created, true)
})

test('L-3: DNS failure is reported apart from a policy block at write time only', async (t) => {
  withStrictPolicy(t)
  assert.equal(
    await proxyWriteBlockReason({ host: 'nxdomain.example', port: 1080 }, { lookup }),
    'proxy_host_unresolvable',
  )
  assert.equal(
    await proxyWriteBlockReason({ host: 'evil-loopback.example', port: 1080 }, { lookup }),
    'proxy_host_blocked',
  )
  assert.equal(await proxyWriteBlockReason({ host: 'good.example', port: 1080 }, { lookup }), null)
  // Dial-time callers keep the single fail-closed code they already handle.
  const dial = await resolvedProxyDial({ host: 'nxdomain.example', port: 1080 }, { lookup })
  assert.equal(dial.blocked, 'proxy_host_blocked')
})
