/**
 * xAI OAuth. Default login is the device-code flow used by the Grok CLI:
 * public client id, scope, and endpoints from OIDC discovery. No redirect URI.
 * Authorization-code + PKCE remains only when an operator set authorize_url and redirect_uri.
 *
 * Node keeps the login sessions; every auth.x.ai request goes through `transport`,
 * which in production is the slot's kin-grok-kernel (grok-kernel-oauth.mjs). The
 * kernel does discovery, picks the endpoints and adds client_id, from the slot exit.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GROK_OAUTH_DEVICE_GRANT, grokOauthConfig } from '../protocol/grok-route.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { sleep } from '../core/clock.mjs'
import { b64url } from './b64url.mjs'

export const GROK_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
const DEVICE_POLL_FLOOR_SEC = 5
const DEVICE_POLL_CAP_SEC = 30 * 60

const sessions = new Map()
const deviceSessions = new Map()
const DEVICE_LOCK_STALE_MS = 15_000
const DEVICE_LOCK_WAIT_MS = 5_000

function fail(code, message, extra = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extra)
  return err
}

function sweepExpired(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > GROK_OAUTH_SESSION_TTL_MS) sessions.delete(id)
  }
  for (const [id, session] of deviceSessions) {
    if (now > session.expiresAt) deviceSessions.delete(id)
  }
}

function deviceSessionPath(projectRoot) {
  return path.join(projectRoot, 'data', 'run', 'grok-device-sessions.json')
}

function readDeviceFile(projectRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(deviceSessionPath(projectRoot), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

async function withDeviceFileLock(projectRoot, fn) {
  const file = `${deviceSessionPath(projectRoot)}.lock`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const deadline = Date.now() + DEVICE_LOCK_WAIT_MS
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 })
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      let age = 0
      try {
        age = Date.now() - fs.statSync(file).mtimeMs
      } catch {
        continue
      }
      if (age > DEVICE_LOCK_STALE_MS) {
        fs.rmSync(file, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        const busy = new Error('grok device session lock busy')
        busy.code = 'grok_device_session_busy'
        throw busy
      }
      await sleep(50)
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(file, { force: true })
  }
}

function storedDeviceSession(session) {
  return {
    deviceCode: session.deviceCode,
    vmId: session.vmId,
    interval: session.interval,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  }
}

function hydrateDeviceSession(row) {
  if (!row || typeof row !== 'object') return null
  const expiresAt = Number(row.expiresAt)
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null
  if (!row.deviceCode || !row.vmId) return null
  return {
    deviceCode: String(row.deviceCode),
    vmId: String(row.vmId),
    interval: Number(row.interval) || DEVICE_POLL_FLOOR_SEC,
    createdAt: Number(row.createdAt) || Date.now(),
    expiresAt,
  }
}

/** Device codes survive a restart. Without projectRoot the session stays in this process only. */
async function rememberDeviceSession(projectRoot, sessionId, session) {
  deviceSessions.set(sessionId, session)
  if (!projectRoot) return
  await withDeviceFileLock(projectRoot, async () => {
    const all = readDeviceFile(projectRoot)
    const now = Date.now()
    for (const [id, row] of Object.entries(all)) {
      if (!row || !(Number(row.expiresAt) > now)) delete all[id]
    }
    all[sessionId] = storedDeviceSession(session)
    atomicWriteJson(deviceSessionPath(projectRoot), all, { mode: 0o600 })
  })
}

async function forgetDeviceSession(projectRoot, sessionId) {
  deviceSessions.delete(sessionId)
  if (!projectRoot) return
  await withDeviceFileLock(projectRoot, async () => {
    const all = readDeviceFile(projectRoot)
    if (!Object.hasOwn(all, sessionId)) return
    delete all[sessionId]
    atomicWriteJson(deviceSessionPath(projectRoot), all, { mode: 0o600 })
  })
}

async function loadDeviceSession(projectRoot, sessionId) {
  sweepExpired()
  const cached = deviceSessions.get(sessionId)
  if (cached) return cached
  if (!projectRoot || !sessionId) return null
  const raw = readDeviceFile(projectRoot)[sessionId]
  const session = hydrateDeviceSession(raw)
  if (!session) {
    if (raw) await forgetDeviceSession(projectRoot, sessionId)
    return null
  }
  deviceSessions.set(sessionId, session)
  return session
}

function requireConfig(routing) {
  const resolved = grokOauthConfig(routing)
  if (!resolved.ok) {
    throw fail('grok_oauth_not_configured', 'xAI OAuth 地址无效', {
      status: 503,
      missing: resolved.missing,
    })
  }
  return resolved.config
}

function requirePkceConfig(routing) {
  const config = requireConfig(routing)
  const missing = ['authorize_url', 'redirect_uri'].filter((key) => !config[key])
  if (missing.length) {
    throw fail('grok_oauth_not_configured', '未配置授权回调。Grok 默认用设备码登录，不用填这些地址。', {
      status: 503,
      missing,
    })
  }
  return config
}

/**
 * One auth.x.ai call. `{ status, payload }`, or `{ status: 0, payload: null, error }`
 * when no request left (no exit, kernel down, timeout, endpoint not allowed).
 */
async function oauthCall(transport, request) {
  if (typeof transport !== 'function') return { status: 0, payload: null, error: 'proxy_required' }
  try {
    const res = (await transport(request)) || {}
    if (res.error) return { status: 0, payload: null, error: String(res.error) }
    return { status: Number(res.status) || 0, payload: res.payload ?? null }
  } catch (error) {
    return { status: 0, payload: null, error: error?.code || 'oauth_transport' }
  }
}

function transportFailure(error) {
  if (error === 'proxy_required') return error
  if (error === 'grok_oauth_not_configured' || error === 'grok_oauth_discovery_failed') return error
  return error === 'timeout' ? 'timeout' : 'fetch_failed'
}

/** Accepts the full callback URL, a `?code=&state=` query, `code#state`, or a bare code. */
export function parseGrokOAuthCallback(raw) {
  const text = String(raw || '').trim()
  if (!text) return { code: '', state: '', error: '' }
  try {
    const url = new URL(text)
    return {
      code: String(url.searchParams.get('code') || '').trim(),
      state: String(url.searchParams.get('state') || '').trim(),
      error: String(url.searchParams.get('error') || '').trim(),
    }
  } catch {
    const hash = text.indexOf('#')
    if (hash !== -1 && !text.includes('=')) {
      return { code: text.slice(0, hash).trim(), state: text.slice(hash + 1).trim(), error: '' }
    }
    if (!text.includes('=')) return { code: text, state: '', error: '' }
    const params = new URLSearchParams(text.includes('?') ? text.slice(text.indexOf('?') + 1) : text)
    return {
      code: String(params.get('code') || '').trim(),
      state: String(params.get('state') || '').trim(),
      error: String(params.get('error') || '').trim(),
    }
  }
}

export function generateGrokAuthUrl({ routing, vmId, proxyUrl } = {}) {
  sweepExpired()
  if (!vmId) throw fail('vm_required', 'vm_id required (先创建虚拟机)')
  const config = requirePkceConfig(routing)
  if (proxyUrl == null) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，请先分配代理再生成授权链接')
  const state = b64url(crypto.randomBytes(32))
  const codeVerifier = b64url(crypto.randomBytes(32))
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const sessionId = crypto.randomBytes(16).toString('hex')
  const createdAt = Date.now()
  const url = new URL(config.authorize_url)
  for (const [key, value] of Object.entries(config.extra_authorize_params)) url.searchParams.set(key, value)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.client_id)
  url.searchParams.set('redirect_uri', config.redirect_uri)
  if (config.scope) url.searchParams.set('scope', config.scope)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  sessions.set(sessionId, {
    state,
    codeVerifier,
    proxyUrl: String(proxyUrl),
    vmId: String(vmId),
    tokenUrl: config.token_url,
    clientId: config.client_id,
    redirectUri: config.redirect_uri,
    createdAt,
  })
  return {
    auth_url: url.toString(),
    session_id: sessionId,
    expires_at: createdAt + GROK_OAUTH_SESSION_TTL_MS,
    vm_id: String(vmId),
    redirect_uri: config.redirect_uri,
    flavor: 'grok',
    flow: 'pkce',
  }
}

/**
 * Start a device-code login. The device_code stays on the server; the panel only gets the user code.
 */
export async function startGrokDeviceLogin({ routing, vmId, transport, projectRoot } = {}) {
  sweepExpired()
  if (!vmId) throw fail('vm_required', 'vm_id required (先创建虚拟机)')
  requireConfig(routing)
  const res = await oauthCall(transport, { action: 'device_authorize' })
  if (res.error) {
    const code = transportFailure(res.error)
    if (code === 'proxy_required') {
      throw fail('proxy_required', '虚拟机未绑定 SOCKS5，请先分配代理再开始授权', { status: 503 })
    }
    if (code === 'grok_oauth_discovery_failed') {
      throw fail('grok_oauth_discovery_failed', '读不到 xAI 授权地址，请检查槽位代理能否访问 auth.x.ai', {
        status: 502,
      })
    }
    throw fail(code, 'xAI 设备码请求失败，请检查槽位代理后重试', { status: 502 })
  }
  if ((res.status || 0) >= 400) {
    throw fail('device_code_failed', `xAI 设备码请求失败 (HTTP ${res.status})`, {
      status: 502,
      upstream_status: res.status,
    })
  }
  const payload = res.payload || {}
  const deviceCode = String(payload.device_code || '').trim()
  const userCode = String(payload.user_code || '').trim()
  const verificationUri = String(payload.verification_uri || '').trim()
  const verificationComplete = String(payload.verification_uri_complete || '').trim()
  if (!deviceCode || !userCode || (!verificationUri && !verificationComplete)) {
    throw fail('device_code_empty', 'xAI 设备码响应不完整', { status: 502 })
  }
  const interval = Math.max(DEVICE_POLL_FLOOR_SEC, Number(payload.interval) || DEVICE_POLL_FLOOR_SEC)
  const expiresIn = Math.min(
    DEVICE_POLL_CAP_SEC,
    Math.max(DEVICE_POLL_FLOOR_SEC, Number(payload.expires_in) || DEVICE_POLL_CAP_SEC),
  )
  const createdAt = Date.now()
  const sessionId = crypto.randomBytes(16).toString('hex')
  await rememberDeviceSession(projectRoot, sessionId, {
    deviceCode,
    vmId: String(vmId),
    interval,
    createdAt,
    expiresAt: createdAt + expiresIn * 1000,
  })
  return {
    auth_url: verificationComplete || verificationUri,
    verification_uri: verificationUri,
    verification_uri_complete: verificationComplete,
    user_code: userCode,
    session_id: sessionId,
    expires_at: createdAt + expiresIn * 1000,
    interval_sec: interval,
    vm_id: String(vmId),
    flavor: 'grok',
    flow: 'device',
  }
}

/** One device-code poll. Pending is not an error; the panel calls this again. */
export async function pollGrokDeviceLogin({ sessionId, vmId, transport, projectRoot } = {}) {
  sweepExpired()
  const session = await loadDeviceSession(projectRoot, sessionId)
  if (!session) return { ok: false, error: 'session_expired', status: 'expired' }
  if (vmId && session.vmId !== String(vmId)) return { ok: false, error: 'session_vm_mismatch', status: 'failed' }
  const res = await oauthCall(transport, {
    action: 'token',
    form: { grant_type: GROK_OAUTH_DEVICE_GRANT, device_code: session.deviceCode },
  })
  if (res.error) {
    const code = transportFailure(res.error)
    if (code === 'proxy_required' || code === 'grok_oauth_not_configured') {
      return { ok: false, error: code, status: 'failed' }
    }
    return { ok: false, error: code, status: 'pending', interval_sec: session.interval }
  }
  const oauthError = String(res.payload?.error || '')
  if (oauthError === 'authorization_pending') {
    return { ok: false, error: 'authorization_pending', status: 'pending', interval_sec: session.interval }
  }
  if (oauthError === 'slow_down') {
    session.interval += DEVICE_POLL_FLOOR_SEC
    await rememberDeviceSession(projectRoot, sessionId, session)
    return { ok: false, error: 'slow_down', status: 'pending', interval_sec: session.interval }
  }
  if (oauthError === 'expired_token') {
    await forgetDeviceSession(projectRoot, sessionId)
    return { ok: false, error: 'expired', status: 'expired' }
  }
  if (oauthError === 'access_denied') {
    await forgetDeviceSession(projectRoot, sessionId)
    return { ok: false, error: 'access_denied', status: 'denied' }
  }
  if (oauthError) {
    await forgetDeviceSession(projectRoot, sessionId)
    return { ok: false, error: oauthError, status: 'failed', upstream_status: res.status }
  }
  if ((res.status || 0) >= 400) {
    return {
      ok: false,
      error: 'exchange_failed',
      status: 'pending',
      interval_sec: session.interval,
      upstream_status: res.status,
    }
  }
  const tok = tokenResult(res.payload)
  if (!tok.access_token) return { ok: false, error: 'exchange_empty', status: 'failed' }
  await forgetDeviceSession(projectRoot, sessionId)
  return { ok: true, status: 'authorized', ...tok, flavor: 'grok', source: 'grok-device' }
}

function tokenResult(payload, { fallbackRefresh = '' } = {}) {
  const access = String(payload?.access_token || '').trim()
  const expiresIn = Number(payload?.expires_in)
  return {
    access_token: access,
    refresh_token: String(payload?.refresh_token || fallbackRefresh || '').trim(),
    id_token: String(payload?.id_token || '').trim(),
    scope: String(payload?.scope || '').trim(),
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
  }
}

export async function exchangeGrokAuthCode({ sessionId, code, vmId, transport } = {}) {
  sweepExpired()
  const session = sessions.get(sessionId)
  if (!session || Date.now() - session.createdAt > GROK_OAUTH_SESSION_TTL_MS) {
    if (session) sessions.delete(sessionId)
    throw fail('session_expired', '授权会话不存在或已过期，请重新生成授权链接')
  }
  if (vmId && session.vmId !== String(vmId)) throw fail('session_vm_mismatch', '授权会话与当前虚拟机不匹配')
  const parsed = parseGrokOAuthCallback(code)
  if (parsed.error) throw fail('authorize_denied', `xAI 授权被拒绝：${parsed.error}`)
  if (!parsed.code) throw fail('code_required', '请粘贴 xAI 回调 URL 或授权码')
  if (parsed.state && parsed.state !== session.state) throw fail('state_mismatch', '回调 state 与授权会话不匹配')
  const res = await oauthCall(transport, {
    action: 'token',
    form: {
      grant_type: 'authorization_code',
      code: parsed.code,
      redirect_uri: session.redirectUri,
      code_verifier: session.codeVerifier,
    },
  })
  if (res.error) {
    const failure = transportFailure(res.error)
    if (failure === 'proxy_required') throw fail('proxy_required', '虚拟机未绑定 SOCKS5，无法换票')
    throw fail(failure, 'xAI 换票请求失败，请检查槽位代理后重试')
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw fail('exchange_rejected', 'xAI 拒绝了授权码，请重新生成授权链接', { upstream_status: res.status })
  }
  if (res.status >= 400)
    throw fail('exchange_failed', `xAI 换票失败 (HTTP ${res.status})`, { upstream_status: res.status })
  const tok = tokenResult(res.payload)
  if (!tok.access_token) throw fail('exchange_empty', 'xAI 换票响应缺少 access_token')
  sessions.delete(sessionId)
  return { ...tok, flavor: 'grok', source: 'grok-oauth' }
}

/**
 * Turn an imported refresh token into an access token before it is saved. Never throws.
 * The slot's stored token is refreshed by the kernel itself (grok-token.mjs), not here.
 * `refresh_rejected` means the grant is dead and the slot needs a new login.
 */
export async function refreshGrokAccessToken({ routing, refreshToken, transport } = {}) {
  const rt = String(refreshToken || '').trim()
  if (!rt) return { ok: false, error: 'missing_refresh_token' }
  const resolved = grokOauthConfig(routing)
  if (!resolved.ok) return { ok: false, error: 'grok_oauth_not_configured', missing: resolved.missing }
  const res = await oauthCall(transport, { action: 'token', form: { grant_type: 'refresh_token', refresh_token: rt } })
  if (res.error) {
    const failure = transportFailure(res.error)
    const passthrough =
      failure === 'proxy_required' ||
      failure === 'grok_oauth_not_configured' ||
      failure === 'grok_oauth_discovery_failed'
    return { ok: false, error: passthrough ? failure : failure === 'timeout' ? 'timeout' : 'fetch_failed' }
  }
  const oauthError = String(res.payload?.error || '')
  if (res.status === 401 || res.status === 403 || oauthError === 'invalid_grant') {
    return { ok: false, error: 'refresh_rejected', status: res.status }
  }
  if (res.status >= 400) return { ok: false, error: 'refresh_failed', status: res.status }
  const tok = tokenResult(res.payload, { fallbackRefresh: rt })
  if (!tok.access_token) return { ok: false, error: 'refresh_empty', status: res.status }
  return { ok: true, ...tok }
}

function decodeJwtClaims(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2) return null
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** `tier` claim on the xAI access token (seen as a number, e.g. 5). Display only, not verified. */
export function grokTokenTier(accessToken) {
  const tier = decodeJwtClaims(accessToken)?.tier
  if (typeof tier === 'number' && Number.isFinite(tier)) return tier
  if (typeof tier === 'string' && tier.trim()) return tier.trim()
  return null
}

/** Display-only identity. Claims are decoded, not verified. */
export function grokIdentityFromTokens({ id_token, access_token } = {}) {
  const claims = decodeJwtClaims(id_token) || decodeJwtClaims(access_token) || {}
  const email = typeof claims.email === 'string' ? claims.email.trim() : ''
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : ''
  return { email: email || null, account_id: sub || null }
}

export function resetGrokAuthUrlSessions() {
  sessions.clear()
  deviceSessions.clear()
}
