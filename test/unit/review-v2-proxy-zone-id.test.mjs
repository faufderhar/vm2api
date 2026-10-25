import test from 'node:test'
import assert from 'node:assert/strict'

test('L-10: IPv6 zone ids are blocked even when private proxies are allowed', async () => {
  const prev = process.env.VM2API_ALLOW_PRIVATE_PROXY
  try {
    for (const allow of [undefined, '1']) {
      if (allow === undefined) delete process.env.VM2API_ALLOW_PRIVATE_PROXY
      else process.env.VM2API_ALLOW_PRIVATE_PROXY = allow
      const { isUnsafeProxyHost } = await import(`../../src/lib/vm/proxy-policy.mjs?zone=${allow}`)
      for (const host of ['fe80::1%eth0', '[fe80::1%eth0]', 'fe80::1%25eth0', '2001:db8::1%1']) {
        assert.equal(isUnsafeProxyHost({ host, port: 1080 }), true, `${host} allow=${allow}`)
      }
      assert.equal(isUnsafeProxyHost({ host: '203.0.113.10', port: 1080 }), false)
      assert.equal(isUnsafeProxyHost({ host: 'proxy.example.com', port: 1080 }), false)
    }
  } finally {
    if (prev === undefined) delete process.env.VM2API_ALLOW_PRIVATE_PROXY
    else process.env.VM2API_ALLOW_PRIVATE_PROXY = prev
  }
})

test('L-10: a zone id in a proxy URL is blocked', async () => {
  const { isUnsafeProxyHost } = await import('../../src/lib/vm/proxy-policy.mjs?zone-url')
  assert.equal(isUnsafeProxyHost({ url: 'socks5://[fe80::1%25eth0]:1080' }), true)
  assert.equal(isUnsafeProxyHost({ url: 'socks5://user:p%40ss@203.0.113.10:1080' }), false)
})
