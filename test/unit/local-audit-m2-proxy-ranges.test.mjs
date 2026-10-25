import test from 'node:test'
import assert from 'node:assert/strict'

test('M2: special-purpose IPv4/IPv6 ranges and embedded IPv4 forms are not proxy targets', async () => {
  const { isUnsafeProxyHost } = await import('../../src/lib/vm/proxy-policy.mjs')
  const prev = process.env.VM2API_ALLOW_PRIVATE_PROXY
  delete process.env.VM2API_ALLOW_PRIVATE_PROXY
  try {
    const blocked = [
      '127.0.0.1.',
      'localhost.',
      '192.0.0.1',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      'fec0::1',
      'ff02::1',
      '100::1',
      '64:ff9b:1::a9fe:a9fe',
      '64:ff9b:1::7f00:1',
      '2002:7f00:1::1',
      '2002:a9fe:a9fe::1',
      '2002:0a00:0001::1',
      // Teredo client 127.0.0.1, bit-inverted
      '2001:0:4136:e378:8000:63bf:80ff:fffe',
    ]
    for (const host of blocked) assert.equal(isUnsafeProxyHost({ host }), true, host)
    const allowed = [
      '8.8.8.8',
      '1.1.1.1',
      '198.20.0.1',
      // fake-ip DNS answers live in 198.18/15, so it must stay usable.
      '198.18.0.1',
      '223.255.255.1',
      '2606:4700:4700::1111',
      '2002:0808:0808::1',
      'proxy.example.com',
      // Documentation ranges are left alone: not routable, and used as fixtures.
      '203.0.113.10',
      '2001:db8::1',
    ]
    for (const host of allowed) assert.equal(isUnsafeProxyHost({ host }), false, host)
    // Metadata and reserved stay blocked even with the private-proxy opt-in.
    process.env.VM2API_ALLOW_PRIVATE_PROXY = '1'
    for (const host of ['169.254.169.254', '240.0.0.1', '224.0.0.1', '2002:a9fe:a9fe::1']) {
      assert.equal(isUnsafeProxyHost({ host }), true, host)
    }
    assert.equal(isUnsafeProxyHost({ host: '192.0.0.1' }), false)
  } finally {
    if (prev == null) delete process.env.VM2API_ALLOW_PRIVATE_PROXY
    else process.env.VM2API_ALLOW_PRIVATE_PROXY = prev
  }
})
