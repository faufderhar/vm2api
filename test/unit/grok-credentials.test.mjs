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
  refreshGrokAccessToken,
  resetGrokAuthUrlSessions,
} from '../../src/lib/oauth/grok-oauth.mjs'
import {
  grokCredentialPath,
  parseGrokCredentialInput,
  persistGrokRateLimit,
  readGrokAccount,
  summarizeGrokSlot,
  upsertGrokAccount,
} from '../../src/lib/vm/grok-slot.mjs'
import { ensureGrokAccessToken, resetGrokTokenInflight } from '../../src/lib/oauth/grok-token.mjs'

const OAUTH = {
  authorize_url: 'https://auth.example.test/authorize',
  token_url: 'https://auth.example.test/token',
  client_id: 'client-1',
  redirect_uri: 'http://127.0.0.1:56121/callback',
  scope: 'openid offline_access',
}
const routing = { grok: { enabled: true, oauth: OAUTH } }

function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`
}

function tokenResponse(status, body) {
  return { status, json: async () => body }
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
  assert.equal(grok.base_url, 'https://api.x.ai')
  assert.equal(grok.protocols['openai.responses'].mode, 'native')
  assert.equal(grok.protocols['anthropic.messages'].mode, 'reject')
  const cfg = grokOauthConfig({})
  assert.equal(cfg.ok, false)
  assert.equal(cfg.code, 'grok_oauth_not_configured')
  assert.deepEqual(cfg.missing, ['authorize_url', 'token_url', 'client_id', 'redirect_uri'])
  assert.equal(isGrokProtocolAllowed('openai.chat', {}).code, 'grok_disabled')
})

test('routing rejects non-https endpoints and unsupported protocol modes', () => {
  assert.equal(grokOauthConfig({ grok: { oauth: { ...OAUTH, token_url: 'http://x.test/t' } } }).ok, false)
  assert.throws(() => validateGrokRoutingPatch({ grok: { oauth: { token_url: 'http://x.test/t' } } }), /https/)
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
  assert.throws(() => generateGrokAuthUrl({ routing: {}, vmId: 'vm-g1', proxyUrl: 'socks5h://p' }), (err) => {
    assert.equal(err.code, 'grok_oauth_not_configured')
    assert.equal(err.status, 503)
    assert.ok(err.missing.includes('client_id'))
    return true
  })
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

test('exchange verifies state and vm, posts PKCE verifier, single use', async () => {
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
  let posted
  const fetchImpl = async (url, init) => {
    posted = { url, body: new URLSearchParams(init.body), headers: init.headers }
    return tokenResponse(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
  }
  const tok = await exchangeGrokAuthCode({
    sessionId: out.session_id,
    code: `http://127.0.0.1:56121/callback?code=the-code&state=${state}`,
    vmId: 'vm-g1',
    fetchImpl,
  })
  assert.equal(posted.url, OAUTH.token_url)
  assert.equal(posted.body.get('grant_type'), 'authorization_code')
  assert.equal(posted.body.get('code'), 'the-code')
  const verifier = posted.body.get('code_verifier')
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge)
  assert.equal(posted.headers['user-agent'], undefined)
  assert.equal(tok.access_token, 'at-1')
  assert.ok(tok.expires_at > Date.now())
  await assert.rejects(exchangeGrokAuthCode({ sessionId: out.session_id, code: 'x' }), { code: 'session_expired' })
})

test('refresh maps invalid_grant to refresh_rejected and keeps the old refresh token', async () => {
  const rejected = await refreshGrokAccessToken({
    routing,
    refreshToken: 'rt',
    fetchImpl: async () => tokenResponse(400, { error: 'invalid_grant' }),
  })
  assert.equal(rejected.error, 'refresh_rejected')
  const fine = await refreshGrokAccessToken({
    routing,
    refreshToken: 'rt',
    fetchImpl: async () => tokenResponse(200, { access_token: 'at-2', expires_in: 60 }),
  })
  assert.equal(fine.ok, true)
  assert.equal(fine.refresh_token, 'rt')
  assert.equal((await refreshGrokAccessToken({ routing: {}, refreshToken: 'rt' })).error, 'grok_oauth_not_configured')
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
  const json = parseGrokCredentialInput(JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r', expires_in: 60 } }))
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

test('ensure token: fresh token skips refresh, concurrent callers share one refresh', async () => {
  resetGrokTokenInflight()
  const root = tempProject()
  upsertGrokAccount(root, 'vm-g1', { access_token: 'old', refresh_token: 'rt', expires_at: Date.now() + 3600_000 })
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    await new Promise((r) => setTimeout(r, 20))
    return tokenResponse(200, { access_token: `new-${calls}`, refresh_token: 'rt2', expires_in: 3600 })
  }
  const vm = { id: 'vm-g1' }
  const fresh = await ensureGrokAccessToken({ projectRoot: root, vm, routing, fetchImpl })
  assert.equal(fresh.access_token, 'old')
  assert.equal(calls, 0)
  upsertGrokAccount(root, 'vm-g1', { expires_at: Date.now() + 10_000 })
  const all = await Promise.all(
    Array.from({ length: 10 }, () => ensureGrokAccessToken({ projectRoot: root, vm, routing, fetchImpl })),
  )
  assert.equal(calls, 1)
  for (const r of all) assert.equal(r.access_token, 'new-1')
  assert.equal(readGrokAccount(root, 'vm-g1').refresh_token, 'rt2')
  const forced = await ensureGrokAccessToken({ projectRoot: root, vm, routing, fetchImpl, force: true })
  assert.equal(forced.access_token, 'new-2')
})

test('ensure token: rejected refresh records auth_error; transient failure keeps a live token', async () => {
  resetGrokTokenInflight()
  const root = tempProject()
  upsertGrokAccount(root, 'vm-g1', { access_token: 'old', refresh_token: 'rt', expires_at: Date.now() + 10_000 })
  const transient = await ensureGrokAccessToken({
    projectRoot: root,
    vm: { id: 'vm-g1' },
    routing,
    fetchImpl: async () => tokenResponse(503, {}),
  })
  assert.equal(transient.ok, true)
  assert.equal(transient.access_token, 'old')
  const dead = await ensureGrokAccessToken({
    projectRoot: root,
    vm: { id: 'vm-g1' },
    routing,
    force: true,
    fetchImpl: async () => tokenResponse(400, { error: 'invalid_grant' }),
  })
  assert.equal(dead.code, 'grok_refresh_rejected')
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-g1.json'), 'utf8'))
  assert.equal(vm.grok.auth_error.code, 'oauth_refresh_rejected')
  assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-g1', 'run', 'grok-refresh.lock')), false)
})
