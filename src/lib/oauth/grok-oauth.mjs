/**
 * xAI OAuth (authorization code + PKCE). Endpoints and client come from routing.grok.oauth;
 * the callback is pasted back and the token call egresses through the slot SOCKS5.
 */
import crypto from 'node:crypto'
import { grokOauthConfig } from '../protocol/grok-route.mjs'
import { makeProxyFetch, readFetchBody } from '../transport/proxy-fetch.mjs'

export const GROK_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000

const sessions = new Map()

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
}

function requireConfig(routing) {
  const resolved = grokOauthConfig(routing)
  if (!resolved.ok) {
    throw fail('grok_oauth_not_configured', 'xAI OAuth 未配置，请先在设置 → Grok 中填写', {
      status: 503,
      missing: resolved.missing,
    })
  }
  return resolved.config
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
  const config = requireConfig(routing)
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
  }
}

async function postToken({ tokenUrl, form, proxyUrl, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl || makeProxyFetch(proxyUrl, timeoutMs)
  try {
    const res = await fetchFn(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: String(new URLSearchParams(form)),
    })
    return { status: Number(res?.status) || 0, payload: await readFetchBody(res) }
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
  if (!px) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，无法换票')
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
  if (!proxyUrl && !fetchImpl) return { ok: false, error: 'proxy_required' }
  const config = resolved.config
  const form = { grant_type: 'refresh_token', refresh_token: rt, client_id: config.client_id }
  if (config.scope) form.scope = config.scope
  const res = await postToken({ tokenUrl: config.token_url, form, proxyUrl, fetchImpl, timeoutMs })
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
}
