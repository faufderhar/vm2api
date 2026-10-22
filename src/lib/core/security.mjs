import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../vm/vm-file.mjs'

export function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex')
}

export function timingSafeEqualStr(a, b) {
  const left = crypto
    .createHash('sha256')
    .update(String(a ?? ''), 'utf8')
    .digest()
  const right = crypto
    .createHash('sha256')
    .update(String(b ?? ''), 'utf8')
    .digest()
  return crypto.timingSafeEqual(left, right)
}

export function redactSecrets(obj) {
  const s = JSON.stringify(obj)
  return s
    .replace(/sk-ant-[a-z0-9-]{8,}/gi, (m) => m.slice(0, 14) + '***REDACTED***')
    .replace(/sk-(?:kin|vm)-[a-f0-9]{8,}/gi, (m) => m.slice(0, 10) + '***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***REDACTED***')
}

export function extractApiKey(req) {
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim()
    // panel session tokens are not API keys
    if (t.startsWith('kin-panel-')) return ''
    return t
  }
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim()
  return ''
}

/** Simple token bucket per key */
export function createRateLimiter({ capacity = 60, refillPerSec = 1, maxKeys = 10000 } = {}) {
  const buckets = new Map()
  return function allow(key) {
    const now = Date.now()
    let bucket = buckets.get(key)
    if (bucket) buckets.delete(key)
    if (!bucket) {
      while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value)
      bucket = { tokens: capacity, updated: now }
    }
    buckets.set(key, bucket)
    const elapsed = (now - bucket.updated) / 1000
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec)
    bucket.updated = now
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
}

/**
 * Fixed window counter. Used for login, which sits in front of the API-key limiter.
 * Calling it counts one attempt and says whether the key is over `limit`;
 * `.hit(key)` counts and returns the total, `.count(key)` only reads it.
 */
export function createAttemptLimiter({ limit = 30, windowMs = 60_000, maxKeys = 10000 } = {}) {
  const buckets = new Map()
  const live = (id, now) => {
    const bucket = buckets.get(id)
    if (bucket && now - bucket.started <= windowMs) return bucket
    if (bucket) buckets.delete(id)
    return null
  }
  const makeRoom = (now) => {
    if (buckets.size < maxKeys) return
    for (const [storedId, stored] of buckets) {
      if (now - stored.started > windowMs) buckets.delete(storedId)
    }
    if (buckets.size < maxKeys) return
    // Rotating names fills the map with single attempts. Drop the least-used counter,
    // never the busy one under attack, and never refuse everyone because the map is full.
    let victim = null
    for (const [storedId, stored] of buckets) {
      if (!victim || stored.count < victim[1].count) victim = [storedId, stored]
    }
    if (victim) buckets.delete(victim[0])
  }
  const hit = (key, now = Date.now()) => {
    const id = String(key || 'unknown')
    let bucket = live(id, now)
    if (!bucket) {
      makeRoom(now)
      bucket = { started: now, count: 0 }
      buckets.set(id, bucket)
    }
    bucket.count += 1
    return bucket.count
  }
  const count = (key, now = Date.now()) => live(String(key || 'unknown'), now)?.count || 0
  const tooMany = (key) => hit(key) > limit
  tooMany.hit = hit
  tooMany.count = count
  tooMany.limit = limit
  return tooMany
}

export function isLoopbackAddress(address) {
  const raw = String(address || '')
    .trim()
    .toLowerCase()
  return raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1'
}

// Headers a reverse proxy commonly adds. nginx's plain proxy_pass adds none of them,
// so a loopback peer must also have asked for a loopback Host.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'via']

function isLoopbackHost(raw) {
  if (raw == null) return true
  const value = String(raw).trim().toLowerCase()
  const host = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.replace(/:\d+$/, '')
  return host === 'localhost' || isLoopbackAddress(host)
}

export function isLoopbackRequest(req, env = process.env) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
  const hops = forwardedHops(req)
  const claimedProxy = PROXY_HEADERS.some((name) => req?.headers?.[name] != null)
  // A proxy that sent none of those still forwards the public Host (proxy_set_header Host $host).
  if (!claimedProxy) return isLoopbackHost(req?.headers?.host)
  // A reverse proxy on this host makes every remote client look like loopback.
  if (!trustProxy(env)) return false
  const client = hops.length ? hops[hops.length - 1] : ''
  return isLoopbackAddress(client)
}

/**
 * The master API key may call panel routes only from this machine.
 * In-process tests set panelRole and have no socket; a real HTTP request always has one.
 */
export function masterMayAdminister(req, env = process.env) {
  if (req?.apiKeyKind !== 'master') return false
  if (!req.socket) return !!req.panelRole
  return isLoopbackRequest(req, env)
}

export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

/** Panel admin credentials (env override) */
export function getPanelAdmin() {
  return {
    username: process.env.VM2API_ADMIN_USER || process.env.KIN_ADMIN_USER || 'admin',
    password: process.env.VM2API_ADMIN_PASSWORD || process.env.KIN_ADMIN_PASSWORD || '',
  }
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
/** Sliding renewal cannot extend a stolen token forever. */
const SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000
const panelSessions = new Map() // sha256(token) -> { user, role, exp }
let _authenticateUser = null
let _lookupRole = null

/** Optional DB-backed panel users. Env admin remains a fallback. */
export function attachPanelAuth({ authenticate, lookupRole } = {}) {
  _authenticateUser = typeof authenticate === 'function' ? authenticate : null
  _lookupRole = typeof lookupRole === 'function' ? lookupRole : null
}

function panelSessionKey(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
}

function sessionFile() {
  const dir = process.env.KIN_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dir, 'panel-sessions.json')
}

function tightenSessionFile(file) {
  try {
    const mode = fs.statSync(file).mode & 0o777
    if (mode !== 0o600) fs.chmodSync(file, 0o600)
  } catch (err) {
    if (err?.code === 'ENOENT') return
    console.warn(`kin-security: failed to tighten panel sessions: ${err.message}`)
  }
}

function loadSessions() {
  try {
    const f = sessionFile()
    if (!fs.existsSync(f)) return
    tightenSessionFile(f)
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
    const now = Date.now()
    for (const [storedKey, s] of Object.entries(raw || {})) {
      if (s && s.exp > now) {
        const storedAbs = Number(s.abs)
        // Sessions written before the cap existed stop at their current exp.
        const abs = Number.isFinite(storedAbs) && storedAbs > 0 ? storedAbs : s.exp
        if (abs <= now) continue
        const key = storedKey.startsWith('kin-panel-') ? panelSessionKey(storedKey) : storedKey
        panelSessions.set(key, { user: s.user, role: s.role || null, exp: s.exp, abs })
      }
    }
  } catch (err) {
    console.warn(`kin-security: failed to load panel sessions: ${err.message}`)
  }
}

function saveSessions() {
  try {
    const f = sessionFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const obj = {}
    const now = Date.now()
    for (const [token, s] of panelSessions.entries()) {
      if (s.exp > now) obj[token] = s
    }
    atomicWriteJson(f, obj, { mode: 0o600 })
  } catch (err) {
    console.warn(`kin-security: failed to persist panel sessions: ${err.message}`)
  }
}

loadSessions()

export function createPanelSession(username, ttlMs = SESSION_TTL_MS, extra = {}) {
  if (ttlMs && typeof ttlMs === 'object') {
    extra = ttlMs
    ttlMs = extra.ttlMs || SESSION_TTL_MS
  }
  const token = 'kin-panel-' + crypto.randomBytes(24).toString('hex')
  const role = extra.role || (_lookupRole && _lookupRole(username)) || 'admin'
  const now = Date.now()
  panelSessions.set(panelSessionKey(token), {
    user: username,
    role,
    exp: now + ttlMs,
    abs: now + SESSION_ABSOLUTE_MS,
  })
  saveSessions()
  return token
}

function absoluteExpiry(session) {
  const abs = Number(session?.abs)
  if (Number.isFinite(abs) && abs > 0) return abs
  return Number(session?.exp) || 0
}

export function verifyPanelSession(token) {
  if (!token || !token.startsWith('kin-panel-')) return null
  const key = panelSessionKey(token)
  let s = panelSessions.get(key)
  if (!s) {
    // reload from disk once (multi-process / restart)
    loadSessions()
    s = panelSessions.get(key)
  }
  if (!s) return null
  const now = Date.now()
  if (now > s.exp || now > absoluteExpiry(s)) {
    panelSessions.delete(key)
    saveSessions()
    return null
  }
  if (!s.role && _lookupRole) {
    s.role = _lookupRole(s.user) || null
  }
  if (!s.role) {
    const admin = getPanelAdmin()
    s.role = admin.username && s.user === admin.username ? 'admin' : 'user'
  }
  const remaining = s.exp - now
  if (remaining > 0 && remaining < SESSION_TTL_MS / 2) {
    const cap = absoluteExpiry(s)
    const nextExp = Math.min(now + SESSION_TTL_MS, cap)
    if (nextExp > s.exp) {
      s.exp = nextExp
      s.abs = cap
      saveSessions()
    }
  }
  return s
}

export function revokePanelSession(token) {
  if (!token) return
  panelSessions.delete(panelSessionKey(token))
  saveSessions()
}

export function revokePanelSessionsForUser(username, { exceptToken } = {}) {
  const name = String(username || '')
  if (!name) return 0
  const exceptKey = exceptToken ? panelSessionKey(exceptToken) : null
  let n = 0
  for (const [key, s] of panelSessions.entries()) {
    if (s.user !== name) continue
    if (exceptKey && key === exceptKey) continue
    panelSessions.delete(key)
    n += 1
  }
  if (n) saveSessions()
  return n
}

/**
 * A stored session role is not authority. Disabled accounts and role changes
 * drop the token; the caller must also revoke it.
 * @returns {{ ok: true, role: string, id: string|null, quota: number } | { ok: false, reason: string }}
 */
export function panelSessionAccess(session, record) {
  if (!session) return { ok: false, reason: 'missing' }
  if (!record) {
    // Only the env admin is allowed before that user row exists. A deleted
    // user must not keep the role stored in the session file.
    const admin = getPanelAdmin()
    if (session.user === admin.username && admin.password) return { ok: true, role: 'admin', id: null, quota: 0 }
    return { ok: false, reason: 'user_missing' }
  }
  if (record.enabled === false) return { ok: false, reason: 'disabled' }
  const role = record.role || 'user'
  if (session.role && session.role !== role) return { ok: false, reason: 'role_changed' }
  return { ok: true, role, id: record.id || null, quota: record.vm_create_quota ?? 0 }
}

function trustProxy(env = process.env) {
  return String(env.TRUST_PROXY || env.VM2API_TRUST_PROXY || '').trim() === '1'
}

function forwardedHops(req) {
  return String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function loginKeys(req, username, env) {
  const name = String(username || '')
    .trim()
    .toLowerCase()
  const peer = String(req?.socket?.remoteAddress || 'unknown')
  const hops = forwardedHops(req)
  const client = trustProxy(env) && hops.length ? hops[hops.length - 1] : peer
  const account = `user:${name || '-'}`
  return { client: `client:${client}`, account, failed: `failed:${account}@${client}` }
}

/**
 * Counts this login attempt and says whether to refuse it before checking the password.
 * Without TRUST_PROXY the TCP peer is counted and X-Forwarded-For is ignored.
 * A trusted proxy appends the address it accepted, so the right-most hop is used.
 *
 * Every attempt counts against its client. An account only counts failed passwords,
 * and once over the limit it refuses the clients that already failed on it. Anyone can
 * fail logins for `admin`, so refusing every client would let them lock the admin out.
 */
export function loginRateLimited(limiter, req, username, env = process.env) {
  const keys = loginKeys(req, username, env)
  if (limiter.hit(keys.client) > limiter.limit) return true
  return limiter.count(keys.account) >= limiter.limit && limiter.count(keys.failed) > 0
}

/** Call after a wrong password; see loginRateLimited. */
export function recordLoginFailure(limiter, req, username, env = process.env) {
  const keys = loginKeys(req, username, env)
  limiter.hit(keys.account)
  limiter.hit(keys.failed)
}

/**
 * @returns {{ username: string, role: string, id?: string } | null}
 */
export async function verifyPanelLogin(username, password) {
  if (_authenticateUser) {
    const rec = await _authenticateUser(username, password)
    if (rec) return { username: rec.username, role: rec.role || 'user', id: rec.id }
    // Existing DB user (including disabled) must not fall through to env password.
    if (_lookupRole && _lookupRole(username)) return null
  }
  const admin = getPanelAdmin()
  if (!admin.password) return null
  if (!timingSafeEqualStr(String(username || ''), admin.username)) return null
  if (!timingSafeEqualStr(String(password || ''), admin.password)) return null
  return { username: admin.username, role: 'admin', id: null, source: 'env' }
}

function parseCookie(header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/** Extract panel session token: Bearer → x-panel-token → Cookie */
export function extractPanelToken(req) {
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim()
    if (t.startsWith('kin-panel-')) return t
  }
  if (req.headers['x-panel-token']) {
    const t = String(req.headers['x-panel-token']).trim()
    if (t) return t
  }
  const cookies = parseCookie(req.headers.cookie)
  if (cookies.kin_panel_token) return cookies.kin_panel_token
  if (cookies.kin_console_token) return cookies.kin_console_token
  return ''
}

/** Cookie Secure follows the request (or PUBLIC_SCHEME). Default HTTP, not HTTPS. */
export function panelCookieSecure(req, env = process.env) {
  const scheme = String(env.PUBLIC_SCHEME || '')
    .trim()
    .toLowerCase()
  if (scheme === 'https') return true
  if (scheme === 'http') return false
  // A client can send this header. Trust it only when an operator said a proxy sits in front.
  const trustProxy = String(env.TRUST_PROXY || env.VM2API_TRUST_PROXY || '').trim() === '1'
  if (trustProxy) {
    const xf = String(req?.headers?.['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase()
    if (xf === 'https') return true
    if (xf === 'http') return false
  }
  if (req?.socket?.encrypted) return true
  return false
}

/** Build Set-Cookie for panel session (7d) */
export function panelSessionCookie(token, { secure = true, maxAgeSec = 7 * 24 * 3600 } = {}) {
  const parts = [
    `kin_panel_token=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearPanelSessionCookie({ secure = true } = {}) {
  const parts = ['kin_panel_token=', 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
