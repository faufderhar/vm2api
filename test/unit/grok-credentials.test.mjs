import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  grokOauthConfig,
  isGrokProtocolAllowed,
  normalizeGrokRouting,
  validateGrokRoutingPatch,
} from '../../src/lib/protocol/grok-route.mjs'
import {
  exchangeGrokAuthCode,
  generateGrokAuthUrl,
  grokIdentityFromTokens,
  parseGrokOAuthCallback,
  pollGrokDeviceLogin,
  refreshGrokAccessToken,
  resetGrokAuthUrlSessions,
  startGrokDeviceLogin,
} from '../../src/lib/oauth/grok-oauth.mjs'
import {
  grokCredentialPath,
  parseGrokCredentialInput,
  persistGrokRateLimit,
  readGrokAccount,
  summarizeGrokSlot,
  upsertGrokAccount,
} from '../../src/lib/vm/grok-slot.mjs'
import { ensureGrokAccessToken } from '../../src/lib/oauth/grok-token.mjs'

const OAUTH = {
  authorize_url: 'https://auth.x.ai/oauth2/authorize',
  token_url: 'https://auth.x.ai/oauth2/token',
  client_id: 'client-1',
  redirect_uri: 'http://127.0.0.1:56121/callback',
  scope: 'openid offline_access',
}
const routing = { grok: { enabled: true, oauth: OAUTH } }

function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`
}

function tempProject(vm = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-test-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-g1'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-g1.json'),
    JSON.stringify({ id: 'vm-g1', platform: 'xai', family: 'grok', grok: {}, ...vm }),
  )
  return root
}

test('routing defaults are disabled and fail closed without OAuth config', () => {
  const grok = normalizeGrokRouting({})
  assert.equal(grok.enabled, false)
  assert.equal(grok.base_url, 'https://cli-chat-proxy.grok.com')
  assert.equal(grok.protocols['openai.responses'].mode, 'native')
  assert.equal(grok.protocols['anthropic.messages'].mode, 'reject')
  const cfg = grokOauthConfig({})
  assert.equal(cfg.ok, true)
  assert.equal(cfg.config.client_id, 'b1a00492-073a-47ea-816f-4c329264a828')
  assert.equal(cfg.config.token_url, '')
  assert.match(cfg.config.scope, /grok-cli:access/)
  assert.equal(isGrokProtocolAllowed('openai.chat', {}).code, 'grok_disabled')
})

test('routing rejects non-https endpoints and unsupported protocol modes', () => {
  assert.equal(grokOauthConfig({ grok: { oauth: { ...OAUTH, token_url: 'http://x.test/t' } } }).ok, false)
  assert.throws(() => validateGrokRoutingPatch({ grok: { oauth: { token_url: 'http://x.test/t' } } }), /https/)
  assert.equal(grokOauthConfig({ grok: { oauth: { token_url: 'https://auth.example.test/token' } } }).ok, false)
  assert.throws(
    () => validateGrokRoutingPatch({ grok: { oauth: { authorize_url: 'https://evil.example/authorize' } } }),
    /x\.ai/,
  )
  assert.doesNotThrow(() => validateGrokRoutingPatch({ grok: { oauth: { token_url: 'http://127.0.0.1:9/token' } } }))
  assert.throws(
    () => validateGrokRoutingPatch({ grok: { protocols: { 'openai.completions': { mode: 'native' } } } }),
    /reject/,
  )
  assert.throws(() => validateGrokRoutingPatch({ grok: { quota: { limit_5h: 1 } } }), /not supported/)
  assert.doesNotThrow(() => validateGrokRoutingPatch({ grok: { oauth: OAUTH, quota: { max_concurrency: 4 } } }))
  const native = normalizeGrokRouting({ protocols: { 'openai.completions': { mode: 'native', enabled: true } } })
  assert.equal(native.protocols['openai.completions'].mode, 'reject')
  assert.equal(isGrokProtocolAllowed('openai.responses', routing).mode, 'native')
  assert.equal(isGrokProtocolAllowed('openai.completions', routing).code, 'protocol_not_allowed')
})

test('auth url requires config and proxy, and carries PKCE S256', () => {
  resetGrokAuthUrlSessions()
  assert.throws(
    () => generateGrokAuthUrl({ routing: {}, vmId: 'vm-g1', proxyUrl: 'socks5h://p' }),
    (err) => {
      assert.equal(err.code, 'grok_oauth_not_configured')
      assert.equal(err.status, 503)
      assert.ok(err.missing.includes('authorize_url'))
      assert.ok(err.missing.includes('redirect_uri'))
      return true
    },
  )
  assert.throws(() => generateGrokAuthUrl({ routing, vmId: 'vm-g1' }), { code: 'proxy_required' })
  const out = generateGrokAuthUrl({ routing, vmId: 'vm-g1', proxyUrl: 'socks5h://127.0.0.1:1080' })
  const url = new URL(out.auth_url)
  assert.equal(url.origin + url.pathname, OAUTH.authorize_url)
  assert.equal(url.searchParams.get('client_id'), 'client-1')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('redirect_uri'), OAUTH.redirect_uri)
  assert.ok(url.searchParams.get('state'))
  assert.equal(out.flavor, 'grok')
  assert.equal(out.redirect_uri, OAUTH.redirect_uri)
})

test('callback parsing accepts url, query, code#state and bare code', () => {
  assert.deepEqual(parseGrokOAuthCallback('http://127.0.0.1:1/cb?code=a&state=b'), { code: 'a', state: 'b', error: '' })
  assert.deepEqual(parseGrokOAuthCallback('code=a&state=b'), { code: 'a', state: 'b', error: '' })
  assert.deepEqual(parseGrokOAuthCallback('a#b'), { code: 'a', state: 'b', error: '' })
  assert.deepEqual(parseGrokOAuthCallback('abc'), { code: 'abc', state: '', error: '' })
  assert.equal(parseGrokOAuthCallback('http://x.test/cb?error=access_denied').error, 'access_denied')
})

/** A stand-in for the slot kernel's /internal/oauth: records requests and answers in order. */
function kernelTransport(answers) {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = typeof answers === 'function' ? answers(request, calls.length) : answers.shift()
    return next
  }
  return { transport, calls }
}

test('exchange verifies state and vm, sends the PKCE verifier through the kernel, single use', async () => {
  resetGrokAuthUrlSessions()
  const out = generateGrokAuthUrl({ routing, vmId: 'vm-g1', proxyUrl: 'socks5h://127.0.0.1:1080' })
  const state = new URL(out.auth_url).searchParams.get('state')
  const challenge = new URL(out.auth_url).searchParams.get('code_challenge')
  await assert.rejects(
    exchangeGrokAuthCode({ sessionId: out.session_id, code: 'c?code=x&state=wrong', vmId: 'vm-g1' }),
    { code: 'state_mismatch' },
  )
  await assert.rejects(exchangeGrokAuthCode({ sessionId: out.session_id, code: 'x', vmId: 'vm-other' }), {
    code: 'session_vm_mismatch',
  })
  const { transport, calls } = kernelTransport([
    { status: 200, payload: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } },
  ])
  const tok = await exchangeGrokAuthCode({
    sessionId: out.session_id,
    code: `http://127.0.0.1:56121/callback?code=the-code&state=${state}`,
    vmId: 'vm-g1',
    transport,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'token')
  assert.equal(calls[0].form.grant_type, 'authorization_code')
  assert.equal(calls[0].form.code, 'the-code')
  // client_id and the endpoint are the kernel's; Node does not choose them.
  assert.equal('client_id' in calls[0].form, false)
  const verifier = calls[0].form.code_verifier
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge)
  assert.equal(tok.access_token, 'at-1')
  assert.ok(tok.expires_at > Date.now())
  await assert.rejects(exchangeGrokAuthCode({ sessionId: out.session_id, code: 'x' }), { code: 'session_expired' })
})

test('refresh-token import maps invalid_grant to refresh_rejected and keeps the old refresh token', async () => {
  const rejected = await refreshGrokAccessToken({
    routing,
    refreshToken: 'rt',
    transport: kernelTransport([{ status: 400, payload: { error: 'invalid_grant' } }]).transport,
  })
  assert.equal(rejected.error, 'refresh_rejected')
  const { transport, calls } = kernelTransport([{ status: 200, payload: { access_token: 'at-2', expires_in: 60 } }])
  const fine = await refreshGrokAccessToken({ routing, refreshToken: 'rt', transport })
  assert.equal(fine.ok, true)
  assert.equal(fine.refresh_token, 'rt')
  assert.deepEqual(calls[0], { action: 'token', form: { grant_type: 'refresh_token', refresh_token: 'rt' } })
  assert.equal((await refreshGrokAccessToken({ routing: {}, refreshToken: 'rt' })).error, 'proxy_required')
  const noExit = kernelTransport([{ status: 0, error: 'proxy_required' }]).transport
  assert.equal(
    (await refreshGrokAccessToken({ routing, refreshToken: 'rt', transport: noExit })).error,
    'proxy_required',
  )
})

const DEVICE_START = {
  status: 200,
  payload: {
    device_code: 'secret-device',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://auth.x.ai/device',
    expires_in: 600,
    interval: 5,
  },
}

test('device login goes through the kernel and never returns the device code', async () => {
  resetGrokAuthUrlSessions()
  const { transport, calls } = kernelTransport([
    DEVICE_START,
    { status: 400, payload: { error: 'authorization_pending' } },
    { status: 200, payload: { access_token: 'at-device', refresh_token: 'rt-device', expires_in: 60 } },
  ])
  const started = await startGrokDeviceLogin({ routing: {}, vmId: 'vm-g1', transport })
  assert.equal(started.flow, 'device')
  assert.equal(started.user_code, 'ABCD-EFGH')
  assert.equal(JSON.stringify(started).includes('secret-device'), false)
  assert.deepEqual(calls[0], { action: 'device_authorize' })
  const pending = await pollGrokDeviceLogin({ sessionId: started.session_id, vmId: 'vm-g1', transport })
  assert.equal(pending.status, 'pending')
  const done = await pollGrokDeviceLogin({ sessionId: started.session_id, vmId: 'vm-g1', transport })
  assert.equal(done.ok, true)
  assert.equal(done.access_token, 'at-device')
  assert.equal(done.source, 'grok-device')
  assert.deepEqual(calls[2], {
    action: 'token',
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'secret-device' },
  })
})

test('device login reloads the device code after the in-memory map is cleared', async () => {
  resetGrokAuthUrlSessions()
  const root = tempProject()
  try {
    const { transport, calls } = kernelTransport([
      DEVICE_START,
      { status: 200, payload: { access_token: 'at-disk', refresh_token: 'rt-disk', expires_in: 60 } },
    ])
    const started = await startGrokDeviceLogin({ routing: {}, vmId: 'vm-g1', transport, projectRoot: root })
    const file = path.join(root, 'data', 'run', 'grok-device-sessions.json')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.match(fs.readFileSync(file, 'utf8'), /secret-device/)
    assert.equal(JSON.stringify(started).includes('secret-device'), false)
    resetGrokAuthUrlSessions()
    const done = await pollGrokDeviceLogin({
      sessionId: started.session_id,
      vmId: 'vm-g1',
      transport,
      projectRoot: root,
    })
    assert.equal(calls[1].form.device_code, 'secret-device')
    assert.equal(done.ok, true)
    assert.equal(done.access_token, 'at-disk')
    assert.equal(fs.readFileSync(file, 'utf8').includes('secret-device'), false)
    assert.equal(fs.existsSync(`${file}.lock`), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('device login reports a slot without an exit and keeps polling through a kernel hiccup', async () => {
  resetGrokAuthUrlSessions()
  await assert.rejects(
    startGrokDeviceLogin({
      routing: {},
      vmId: 'vm-g1',
      transport: kernelTransport([{ status: 0, error: 'proxy_required' }]).transport,
    }),
    { code: 'proxy_required' },
  )
  const { transport } = kernelTransport([
    DEVICE_START,
    { status: 0, error: 'grok_kernel_unavailable' },
    { status: 200, payload: { access_token: 'at-late', expires_in: 60 } },
  ])
  const started = await startGrokDeviceLogin({ routing: {}, vmId: 'vm-g1', transport })
  const hiccup = await pollGrokDeviceLogin({ sessionId: started.session_id, vmId: 'vm-g1', transport })
  assert.equal(hiccup.status, 'pending')
  const done = await pollGrokDeviceLogin({ sessionId: started.session_id, vmId: 'vm-g1', transport })
  assert.equal(done.access_token, 'at-late')
})

test('identity is decoded from id_token claims', () => {
  assert.deepEqual(grokIdentityFromTokens({ id_token: jwt({ email: 'a@x.test', sub: 'u-1' }) }), {
    email: 'a@x.test',
    account_id: 'u-1',
  })
  assert.deepEqual(grokIdentityFromTokens({ access_token: 'opaque' }), { email: null, account_id: null })
})

test('credential input parsing covers modes and rejects foreign secrets', () => {
  assert.equal(parseGrokCredentialInput('at', 'access_token').access_token, 'at')
  assert.equal(parseGrokCredentialInput('rt', 'refresh_token').refresh_token, 'rt')
  const json = parseGrokCredentialInput(
    JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r', expires_in: 60 } }),
  )
  assert.equal(json.refresh_token, 'r')
  assert.ok(json.expires_at > Date.now())
  assert.throws(() => parseGrokCredentialInput('sk-ant-oat01-x', 'access_token'), { code: 'wrong_platform' })
  assert.throws(() => parseGrokCredentialInput('xai-abc', 'access_token'), { code: 'api_key_not_supported' })
  assert.throws(() => parseGrokCredentialInput('{}'), { code: 'credential_required' })
})

test('credential file is 0600 and summaries never carry tokens', () => {
  const root = tempProject()
  upsertGrokAccount(root, 'vm-g1', {
    access_token: 'secret-at',
    refresh_token: 'secret-rt',
    id_token: jwt({ email: 'g@x.test' }),
    expires_at: Date.now() + 3600_000,
  })
  assert.equal(fs.statSync(grokCredentialPath(root, 'vm-g1')).mode & 0o777, 0o600)
  persistGrokRateLimit(root, 'vm-g1', { until: Date.now() + 30_000, reason: 'rate_limited' })
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-g1.json'), 'utf8'))
  const summary = summarizeGrokSlot(root, vm)
  assert.equal(summary.email, 'g@x.test')
  assert.equal(summary.has_token, true)
  assert.ok(summary.limited_until > Date.now())
  const text = JSON.stringify(summary) + JSON.stringify(vm)
  assert.equal(text.includes('secret-at'), false)
  assert.equal(text.includes('secret-rt'), false)
})

test('summary exposes the access token tier claim without the token', () => {
  const root = tempProject()
  const at = jwt({ sub: 'u1', tier: 5, scope: 'openid' })
  upsertGrokAccount(root, 'vm-g1', { access_token: at, refresh_token: 'rt', expires_at: Date.now() + 3600_000 })
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-g1.json'), 'utf8'))
  const summary = summarizeGrokSlot(root, vm)
  assert.equal(summary.token_tier, 5)
  assert.equal(JSON.stringify(summary).includes(at), false)
  upsertGrokAccount(root, 'vm-g1', { access_token: 'opaque', refresh_token: 'rt' }, { replaceCredentials: true })
  assert.equal(summarizeGrokSlot(root, vm).token_tier, null)
})

test('ensure token asks the slot kernel and records the new state; Node never posts the refresh token', async () => {
  const root = tempProject()
  upsertGrokAccount(root, 'vm-g1', { access_token: 'old', refresh_token: 'rt', expires_at: Date.now() + 10_000 })
  const { transport, calls } = kernelTransport(async () => {
    // The kernel writes the file itself; this stands in for that write.
    upsertGrokAccount(root, 'vm-g1', { access_token: 'new', refresh_token: 'rt2', expires_at: Date.now() + 3600_000 })
    return { status: 200, payload: { ok: true, refreshed: true, expires_at: Date.now() + 3600_000 } }
  })
  const forced = await ensureGrokAccessToken({
    projectRoot: root,
    vm: { id: 'vm-g1' },
    routing,
    force: true,
    transport,
  })
  assert.deepEqual(calls, [{ action: 'refresh', force: true }])
  assert.equal(forced.ok, true)
  assert.equal(forced.refreshed, true)
  assert.equal(forced.account.access_token, 'new')
  assert.equal('access_token' in forced, false)
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-g1.json'), 'utf8'))
  assert.equal(vm.grok.auth_error, null)
  assert.ok(vm.grok.last_refresh_at)
})

test('ensure token: rejected refresh records auth_error; a transient failure is reported, not recorded', async () => {
  const root = tempProject()
  upsertGrokAccount(root, 'vm-g1', { access_token: 'old', refresh_token: 'rt', expires_at: Date.now() + 10_000 })
  const transient = await ensureGrokAccessToken({
    projectRoot: root,
    vm: { id: 'vm-g1' },
    routing,
    transport: kernelTransport([{ status: 0, error: 'refresh_failed' }]).transport,
  })
  assert.equal(transient.code, 'grok_refresh_failed')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-g1.json'), 'utf8')).grok.auth_error, undefined)
  const dead = await ensureGrokAccessToken({
    projectRoot: root,
    vm: { id: 'vm-g1' },
    routing,
    force: true,
    transport: kernelTransport([{ status: 0, error: 'refresh_rejected' }]).transport,
  })
  assert.equal(dead.code, 'grok_refresh_rejected')
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-g1.json'), 'utf8'))
  assert.equal(vm.grok.auth_error.code, 'oauth_refresh_rejected')
})

test('last refresh shows a kernel refresh recorded only in the credential file', () => {
  const root = tempProject()
  upsertGrokAccount(root, 'vm-g1', { access_token: 'at', refresh_token: 'rt' })
  const file = grokCredentialPath(root, 'vm-g1')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc.accounts[0].updated_at = '1798761600' // the kernel writes epoch seconds
  fs.writeFileSync(file, JSON.stringify(doc))
  const vm = { id: 'vm-g1', grok: { last_refresh_at: '2026-01-01T00:00:00.000Z' } }
  assert.equal(summarizeGrokSlot(root, vm).last_refresh_at, '2027-01-01T00:00:00.000Z')
})
