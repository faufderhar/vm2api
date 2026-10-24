import test from 'node:test'
import assert from 'node:assert/strict'
import { assertProxyResolved, pinSocksProxyUrl, resolvedProxyDial } from '../../src/lib/vm/proxy-policy.mjs'

test('DNS failure and a loopback answer block the proxy', async () => {
  const failed = await resolvedProxyDial(
    { url: 'socks5://proxy.example:1080' },
    {
      lookup: async () => {
        throw new Error('ENOTFOUND')
      },
    },
  )
  assert.equal(failed.blocked, 'proxy_host_blocked')

  const loopback = await resolvedProxyDial(
    { url: 'socks5://proxy.example:1080' },
    { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
  )
  assert.equal(loopback.blocked, 'proxy_host_blocked')
})

test('a public answer is pinned onto the socks URL handed to egress', async () => {
  const dial = await resolvedProxyDial(
    { url: 'socks5h://user:secret@proxy.example:1080' },
    {
      lookup: async () => [
        { address: '203.0.113.10', family: 4 },
        { address: '198.51.100.2', family: 4 },
      ],
    },
  )
  assert.equal(dial.blocked, null)
  assert.equal(dial.address, '203.0.113.10')
  assert.equal(dial.url, 'socks5h://user:secret@203.0.113.10:1080')
  assert.equal(pinSocksProxyUrl('socks5://203.0.113.10:1080', '198.51.100.2'), 'socks5://203.0.113.10:1080')

  const pinned = await assertProxyResolved('socks5://proxy.example:1080', {
    lookup: async () => [{ address: '203.0.113.10' }],
  })
  assert.equal(pinned, 'socks5://203.0.113.10:1080')
})

test('platform local egress is not looked up', async () => {
  let called = false
  const dial = await resolvedProxyDial(
    { id: 'px-local', scheme: 'local', url: 'socks5://127.0.0.1:1080' },
    {
      lookup: async () => {
        called = true
        return []
      },
    },
  )
  assert.equal(dial.blocked, null)
  assert.equal(dial.local, true)
  assert.equal(called, false)
})
