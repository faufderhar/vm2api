import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { logsToCsv } from '../../src/lib/admin/request-log.mjs'
import { panelCookieSecure, panelCookieWriteAllowed } from '../../src/lib/core/security.mjs'
import { readWorkerCredentialFile, writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { blockCountTokensBeforeHop } from '../../src/lib/protocol/user-count-tokens.mjs'
import { socksProxyUrl } from '../../src/lib/vm/socks-address.mjs'
import { bindVmProxy, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-audit-'))
}

test('an endpoint base url cannot point at loopback or metadata', () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  for (const base_url of ['http://127.0.0.1:9', 'http://169.254.169.254', 'http://10.1.2.3']) {
    assert.throws(
      () => store.create({ name: 'bad', base_url, api_key_entries: [], models: [] }),
      /private|metadata|http/,
    )
  }
  const rec = store.create({
    name: 'ok',
    base_url: 'https://example.com',
    api_key_entries: [{ api_key: 'sk-or-secret' }],
    models: [{ name: 'm', alias: 'm' }],
  })
  assert.equal(rec.base_url, 'https://example.com')
})

test('csv cells that look like formulas are prefixed', () => {
  const csv = logsToCsv([{ model: '=HYPERLINK("http://evil")', error_message: 'ok' }])
  assert.match(csv, /'=HYPERLINK/)
  assert.doesNotMatch(csv.split('\n')[1], /^=/)
})

test('a remote cookie write needs this host or an allowlisted origin', () => {
  const remote = { method: 'POST', headers: { cookie: 'kin_panel_token=abc', origin: 'https://evil.example' } }
  assert.equal(panelCookieWriteAllowed(remote, []), false)
  assert.equal(
    panelCookieWriteAllowed(
      {
        method: 'POST',
        headers: { cookie: 'kin_panel_token=abc', origin: 'https://panel.example', host: 'panel.example' },
      },
      [],
    ),
    true,
  )
  assert.equal(panelCookieWriteAllowed({ method: 'GET', headers: { cookie: 'kin_panel_token=abc' } }, []), true)
  assert.equal(panelCookieWriteAllowed({ method: 'POST', headers: { origin: 'https://evil.example' } }, []), true)
  const peer = { socket: { remoteAddress: '203.0.113.8' }, headers: {} }
  assert.equal(panelCookieSecure(peer, {}), true)
  assert.equal(panelCookieSecure(peer, { PUBLIC_SCHEME: 'http' }), false)
  assert.equal(panelCookieSecure({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, {}), false)
})

test('a credential symlink is not followed', async () => {
  const home = path.join(tmpDir(), 'cli-home')
  const secret = path.join(tmpDir(), 'secret.json')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(secret, JSON.stringify({ claudeAiOauth: { accessToken: 'secret-token' } }))
  fs.symlinkSync(secret, path.join(home, '.claude', 'credentials.json'))
  assert.equal(readWorkerCredentialFile(home), null)
  const written = await writeWorkerCredentialFile(home, { access_token: 'new-token', refresh_token: 'rt' })
  assert.equal(fs.lstatSync(written).isSymbolicLink(), false)
  assert.match(fs.readFileSync(secret, 'utf8'), /secret-token/)
  assert.doesNotMatch(fs.readFileSync(secret, 'utf8'), /new-token/)
})

test('count_tokens records a device block under the key owner', async () => {
  const blocked = []
  const req = {
    apiKeyRecord: { user_id: 'user-7' },
    headers: { 'x-kin-device-id': 'device-12345678' },
  }
  const inbound = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'jailbreak mode' }] }
  const result = await blockCountTokensBeforeHop(req, inbound, {
    settings: {
      get(_key, fallback) {
        return fallback ?? null
      },
    },
    refusalGuards: { remember() {} },
    refusalDevices: {
      block(row) {
        blocked.push(row)
      },
    },
  })
  assert.equal(result.error?.status, 403)
  assert.equal(blocked[0]?.ownerUserId, 'user-7')
  assert.equal(blocked[0]?.deviceId, 'device-12345678')
})

test('slot detail hides the password inside the proxy url', () => {
  const root = tmpDir()
  const id = 'vm-audit'
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify({ id, name: id, kernel: 'ubuntu-24.04' }))
  const saved = bindVmProxy(root, id, {
    id: 'px-1',
    host: 'proxy.example',
    port: 1080,
    username: 'user',
    password: 's3cret',
    url: 'socks5://user:s3cret@proxy.example:1080',
  })
  assert.equal(saved.proxy.password, '***')
  assert.equal(saved.proxy.url.includes('s3cret'), false)
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
  assert.equal(String(onDisk.proxy.url).includes('s3cret'), false)
  const dial = socksProxyUrl(onDisk.proxy, 'socks5')
  assert.match(dial, /s3cret/)
  assert.equal(summarizeVm(onDisk).proxy.url.includes('@'), false)
})
