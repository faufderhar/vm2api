import test from 'node:test'
import assert from 'node:assert/strict'

test('M1: editing a proxy cannot move it onto loopback, private or metadata', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { ProxyPool } = await import('../../src/lib/vm/proxy-pool.mjs')
  const prev = process.env.VM2API_ALLOW_PRIVATE_PROXY
  delete process.env.VM2API_ALLOW_PRIVATE_PROXY
  try {
    const pool = new ProxyPool({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-px-m1-')) })
    pool.stopScheduler()
    pool.importLines('8.8.8.8:1080')
    const p = pool.state.proxies[0]
    for (const host of ['169.254.169.254', '127.0.0.1', '10.0.0.5', 'localhost', '[::1]', '100.100.100.200']) {
      const r = pool.update(p.id, { host, port: 80 })
      assert.equal(r.ok, false, host)
      assert.equal(r.error, 'proxy_host_blocked', host)
    }
    assert.equal(p.host, '8.8.8.8')
    assert.equal(p.port, 1080)
    assert.equal(pool.update(p.id, { host: '1.1.1.1', port: 1081 }).ok, true)
    assert.equal(p.host, '1.1.1.1')
  } finally {
    if (prev == null) delete process.env.VM2API_ALLOW_PRIVATE_PROXY
    else process.env.VM2API_ALLOW_PRIVATE_PROXY = prev
  }
})
