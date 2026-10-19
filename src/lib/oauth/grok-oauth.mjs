/**
 * xAI OAuth. Default login is the device-code flow used by the Grok CLI:
 * public client id, scope, and endpoints from OIDC discovery. No redirect URI.
 * Authorization-code + PKCE remains only when an operator set authorize_url and redirect_uri.
 * Token calls leave through the slot exit. A SOCKS5 URL is used as-is.
 * An empty URL is the slot's own route (本机出口) and is fetched directly.
 * null means the slot has no exit.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  GROK_OAUTH_DEVICE_GRANT,
  GROK_OAUTH_DISCOVERY_URL,
  grokOauthConfig,
  isGrokOauthEndpoint,
} from '../protocol/grok-route.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'

export const GROK_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
const DISCOVERY_TTL_MS = 10 * 60 * 1000
const DEVICE_POLL_FLOOR_SEC = 5
const DEVICE_POLL_CAP_SEC = 30 * 60

const sessions = new Map()
const deviceSessions = new Map()
let discoveryCache = null
const DEVICE_LOCK_STALE_MS = 15_000
const DEVICE_LOCK_WAIT_MS = 5_000

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    tokenUrl: session.tokenUrl,
    clientId: session.clientId,
    proxyUrl: session.proxyUrl,
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
  if (!isGrokOauthEndpoint(row.tokenUrl) || !row.deviceCode || !row.vmId) return null
  return {
    deviceCode: String(row.deviceCode),
    tokenUrl: String(row.tokenUrl),
    clientId: String(row.clientId || ''),
    proxyUrl: row.proxyUrl ? String(row.proxyUrl) : '',
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

function isXaiHttps(value) {
  try {
    const url = new URL(String(value || ''))
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && (host === 'x.ai' || host.endsWith('.x.ai'))
  } catch {
    return false
  }
}

/** null means no exit was resolved. '' is 本机出口 and must not be treated as unbound. */
function egressMissing(proxyUrl, fetchImpl) {
  return proxyUrl == null && !fetchImpl
}

async function readJson(res) {
  if (res && res.body && typeof res.body === 'object' && !res.body.pipe) return res.body
  if (typeof res?.json === 'function') {
    try {
      return await res.json()
    } catch {
      return null
    }
  }
  if (typeof res?.text === 'function') {
    const text = await res.text()
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  return null
}

async function fetchWithProxy(proxyUrl, timeoutMs) {
  const { makeProxyFetch } = await import('../transport/proxy-fetch.mjs')
  return makeProxyFetch(proxyUrl, timeoutMs)
}

/**
 * OIDC discovery. Cached for 10 minutes. Rejects any endpoint that is not https on x.ai.
 */
export async function discoverGrokOauth({ proxyUrl, fetchImpl, timeoutMs, force = false } = {}) {
  if (!force && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return {
      ok: true,
      device_authorization_endpoint: discoveryCache.deviceUrl,
      token_endpoint: discoveryCache.tokenUrl,
    }
  }
  if (egressMissing(proxyUrl, fetchImpl)) return { ok: false, error: 'proxy_required' }
  const fetchFn = fetchImpl || (await fetchWithProxy(proxyUrl, timeoutMs))
  if (!fetchFn) return { ok: false, error: 'proxy_required' }
  let res
  try {
    res = await fetchFn(GROK_OAUTH_DISCOVERY_URL, { method: 'GET', headers: { accept: 'application/json' } })
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /aborted/i.test(String(e?.message || e))
    return { ok: false, error: aborted ? 'timeout' : 'discovery_failed' }
  }
  const payload = await readJson(res)
  const status = Number(res?.status) || 0
  if (status !== 200) return { ok: false, error: 'discovery_failed', status }
  const deviceUrl = String(payload?.device_authorization_endpoint || '').trim()
  const tokenUrl = String(payload?.token_endpoint || '').trim()
  if (!isXaiHttps(deviceUrl) || !isXaiHttps(tokenUrl)) return { ok: false, error: 'discovery_invalid' }
  discoveryCache = { at: Date.now(), deviceUrl, tokenUrl }
  return { ok: true, device_authorization_endpoint: deviceUrl, token_endpoint: tokenUrl }
}

export function resetGrokOauthDiscovery() {
  discoveryCache = null
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
export async function startGrokDeviceLogin({
  routing,
  vmId,
  proxyUrl,
  fetchImpl,
  timeoutMs,
  projectRoot,
} = {}) {
  sweepExpired()
  if (!vmId) throw fail('vm_required', 'vm_id required (先创建虚拟机)')
  if (egressMissing(proxyUrl, fetchImpl)) {
    throw fail('proxy_required', '虚拟机未绑定 SOCKS5，请先分配代理再开始授权', { status: 503 })
  }
  const config = requireConfig(routing)
  const discovered = await discoverGrokOauth({ proxyUrl, fetchImpl, timeoutMs })
  if (!discovered.ok) {
    throw fail('grok_oauth_discovery_failed', '读不到 xAI 授权地址，请检查槽位代理能否访问 auth.x.ai', {
      status: 502,
    })
  }
  const res = await postToken({
    tokenUrl: discovered.device_authorization_endpoint,
    form: { client_id: config.client_id, scope: config.scope },
    proxyUrl,
    fetchImpl,
    timeoutMs,
  })
  if (res.error) throw fail(res.error, 'xAI 设备码请求失败，请检查槽位代理后重试', { status: 502 })
  if ((res.status || 0) >= 400) {
    throw fail('device_code_failed', `xAI 设备码请求失败 (HTTP ${res.status})`, { status: 502, upstream_status: res.status })
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
    tokenUrl: config.token_url || discovered.token_endpoint,
    clientId: config.client_id,
    proxyUrl: proxyUrl ? String(proxyUrl) : '',
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
export async function pollGrokDeviceLogin({
  sessionId,
  vmId,
  proxyUrl,
  fetchImpl,
  timeoutMs,
  projectRoot,
} = {}) {
  sweepExpired()
  const session = await loadDeviceSession(projectRoot, sessionId)
  if (!session) return { ok: false, error: 'session_expired', status: 'expired' }
  if (vmId && session.vmId !== String(vmId)) return { ok: false, error: 'session_vm_mismatch', status: 'failed' }
  if (!isGrokOauthEndpoint(session.tokenUrl)) {
    await forgetDeviceSession(projectRoot, sessionId)
    return { ok: false, error: 'grok_oauth_not_configured', status: 'failed' }
  }
  const px = proxyUrl ?? session.proxyUrl
  if (egressMissing(px, fetchImpl)) return { ok: false, error: 'proxy_required', status: 'failed' }
  const res = await postToken({
    tokenUrl: session.tokenUrl,
    form: {
      grant_type: GROK_OAUTH_DEVICE_GRANT,
      device_code: session.deviceCode,
      client_id: session.clientId,
    },
    proxyUrl: px,
    fetchImpl,
    timeoutMs,
  })
  if (res.error) return { ok: false, error: res.error, status: 'pending', interval_sec: session.interval }
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
    return { ok: false, error: 'exchange_failed', status: 'pending', interval_sec: session.interval, upstream_status: res.status }
  }
  const tok = tokenResult(res.payload)
  if (!tok.access_token) return { ok: false, error: 'exchange_empty', status: 'failed' }
  await forgetDeviceSession(projectRoot, sessionId)
  return { ok: true, status: 'authorized', ...tok, flavor: 'grok', source: 'grok-device' }
}

async function postToken({ tokenUrl, form, proxyUrl, fetchImpl, timeoutMs }) {
  if (!isGrokOauthEndpoint(tokenUrl)) {
    return { status: 0, payload: null, error: 'grok_oauth_not_configured' }
  }
  const fetchFn = fetchImpl || (await fetchWithProxy(proxyUrl, timeoutMs))
  try {
    const res = await fetchFn(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: String(new URLSearchParams(form)),
    })
    return { status: Number(res?.status) || 0, payload: await readJson(res) }
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /aborted/i.test(String(e?.message || e))
    return { status: 0, payload: null, error: aborted ? 'timeout' : 'fetch_failed' }
  }
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

export async function exchangeGrokAuthCode({ sessionId, code, vmId, proxyUrl, fetchImpl, timeoutMs } = {}) {
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
  const px = proxyUrl ?? session.proxyUrl
  if (egressMissing(px, fetchImpl)) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，无法换票')
  const res = await postToken({
    tokenUrl: session.tokenUrl,
    form: {
      grant_type: 'authorization_code',
      code: parsed.code,
      redirect_uri: session.redirectUri,
      client_id: session.clientId,
      code_verifier: session.codeVerifier,
    },
    proxyUrl: px,
    fetchImpl,
    timeoutMs,
  })
  if (res.error) throw fail(res.error, 'xAI 换票请求失败，请检查槽位代理后重试')
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw fail('exchange_rejected', 'xAI 拒绝了授权码，请重新生成授权链接', { upstream_status: res.status })
  }
  if (res.status >= 400) throw fail('exchange_failed', `xAI 换票失败 (HTTP ${res.status})`, { upstream_status: res.status })
  const tok = tokenResult(res.payload)
  if (!tok.access_token) throw fail('exchange_empty', 'xAI 换票响应缺少 access_token')
  sessions.delete(sessionId)
  return { ...tok, flavor: 'grok', source: 'grok-oauth' }
}

/**
 * Refresh with the configured client. Never throws; returns { ok, ... } like refreshCodexAccessToken.
 * `refresh_rejected` means the grant is dead and the slot needs a new login.
 */
export async function refreshGrokAccessToken({ routing, refreshToken, proxyUrl, fetchImpl, timeoutMs } = {}) {
  const rt = String(refreshToken || '').trim()
  if (!rt) return { ok: false, error: 'missing_refresh_token' }
  const resolved = grokOauthConfig(routing)
  if (!resolved.ok) return { ok: false, error: 'grok_oauth_not_configured', missing: resolved.missing }
  if (egressMissing(proxyUrl, fetchImpl)) return { ok: false, error: 'proxy_required' }
  const config = resolved.config
  let tokenUrl = config.token_url
  if (!tokenUrl) {
    const discovered = await discoverGrokOauth({ proxyUrl, fetchImpl, timeoutMs })
    if (!discovered.ok) {
      return {
        ok: false,
        error: discovered.error === 'proxy_required' ? 'proxy_required' : 'grok_oauth_discovery_failed',
      }
    }
    tokenUrl = discovered.token_endpoint
  }
  const form = { grant_type: 'refresh_token', refresh_token: rt, client_id: config.client_id }
  const res = await postToken({ tokenUrl, form, proxyUrl, fetchImpl, timeoutMs })
  if (res.error) return { ok: false, error: res.error }
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
  resetGrokOauthDiscovery()
}
