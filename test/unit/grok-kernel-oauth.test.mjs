import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL = fileURLToPath(new URL('../../grok-kernel/target/debug/kin-grok-kernel', import.meta.url))
const built = fs.existsSync(KERNEL)
process.env.KIN_GROK_KERNEL_BIN = KERNEL

const { grokKernelExit, grokKernelOauthTransport } = await import('../../src/lib/oauth/grok-kernel-oauth.mjs')
const { refreshGrokAccessToken } = await import('../../src/lib/oauth/grok-oauth.mjs')
const { ensureGrokAccessToken } = await import('../../src/lib/oauth/grok-token.mjs')
const { stopGrokKernel } = await import('../../src/lib/transport/grok-kernel-supervisor.mjs')
const { readGrokAccount, upsertGrokAccount } = await import('../../src/lib/vm/grok-slot.mjs')

/** A local token endpoint standing in for auth.x.ai. Records what the kernel sent. */
async function tokenEndpoint(t, reply) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seen.push({ headers: req.headers, form: [...new URLSearchParams(body)] })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(reply(seen.length)))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}/oauth2/token`, seen }
}

function slot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gko-'))
  const vm = { id: 'vm-k', platform: 'xai', family: 'grok', proxy: { id: 'px-local', scheme: 'local' }, grok: {} }
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  t.after(() => {
    stopGrokKernel(vm.id)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, vm }
}

test('a control-plane slot on local egress dials directly; one without an exit has none', () => {
  assert.deepEqual(grokKernelExit({ proxy: { id: 'px-local', scheme: 'local' } }), {
    proxyUrl: '',
    proxyRequired: false,
  })
  assert.equal(grokKernelExit({ proxy: {} }, { hostProxyUrl: () => '' }), null)
  assert.deepEqual(
    grokKernelExit(
      { node_id: 'n1', proxy: { id: 'px-local', scheme: 'local' } },
      { hostProxyUrl: () => 'socks5h://u:p@127.0.0.1:9' },
    ),
    { proxyUrl: 'socks5h://u:p@127.0.0.1:9', proxyRequired: true },
  )
  assert.equal(
    grokKernelExit(
      { node_id: 'n1' },
      {
        hostProxyUrl: () => {
          throw new Error('node link down')
        },
      },
    ),
    null,
  )
})

test('a refresh-token import is posted by the kernel, not by Node', {
  skip: !built && 'kin-grok-kernel not built',
}, async (t) => {
  const { root, vm } = slot(t)
  const endpoint = await tokenEndpoint(t, () => ({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }))
  const routing = { grok: { enabled: true, oauth: { token_url: endpoint.url } } }
  const tok = await refreshGrokAccessToken({
    routing,
    refreshToken: 'rt-imported',
    transport: grokKernelOauthTransport({ projectRoot: root, vm, routing }),
  })
  assert.equal(tok.ok, true)
  assert.equal(tok.access_token, 'at-new')
  assert.equal(endpoint.seen.length, 1)
  const [request] = endpoint.seen
  assert.doesNotMatch(String(request.headers['user-agent'] || ''), /node-fetch|node/i)
  assert.deepEqual(request.form, [
    ['grant_type', 'refresh_token'],
    ['refresh_token', 'rt-imported'],
    ['client_id', 'b1a00492-073a-47ea-816f-4c329264a828'],
  ])
})

test('the kernel refreshes the slot token once and Node reads the result', {
  skip: !built && 'kin-grok-kernel not built',
}, async (t) => {
  const { root, vm } = slot(t)
  const endpoint = await tokenEndpoint(t, (n) => ({
    access_token: `at-${n}`,
    refresh_token: `rt-${n}`,
    expires_in: 3600,
  }))
  const routing = { grok: { enabled: true, oauth: { token_url: endpoint.url } } }
  upsertGrokAccount(root, vm.id, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: Date.now() + 60_000 })
  const results = await Promise.all(
    Array.from({ length: 4 }, () => ensureGrokAccessToken({ projectRoot: root, vm, routing })),
  )
  assert.ok(results.every((result) => result.ok))
  // Stale by the 300 s skew; four callers, one refresh.
  assert.equal(endpoint.seen.length, 1)
  assert.equal(readGrokAccount(root, vm.id).access_token, 'at-1')
  assert.equal(readGrokAccount(root, vm.id).refresh_token, 'rt-1')
  const fresh = await ensureGrokAccessToken({ projectRoot: root, vm, routing })
  assert.equal(fresh.refreshed, false)
  assert.equal(endpoint.seen.length, 1)
})
