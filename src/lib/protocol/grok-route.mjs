/**
 * Grok (xAI) routing. Claude and Codex traffic never read this object.
 * The OAuth client and scope are the public Grok CLI client (same values as
 * CLIProxyAPI). Device and token endpoints are read from OIDC discovery unless
 * an operator explicitly overrides token_url.
 */
import { normalizeGrokQuotaPolicy, validateGrokQuotaPatch } from '../pool/openai-quota-policy.mjs'
import { typedError } from '../core/errors.mjs'

/** Grok Build CLI chat proxy. Paths append `/v1/chat/completions` and `/v1/responses`. */
export const DEFAULT_GROK_BASE_URL = 'https://cli-chat-proxy.grok.com'
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
/**
 * Device-login scope, as granted to the official 1.0.70 client. Refresh sends no scope,
 * so tokens issued with the older, shorter scope keep refreshing unchanged.
 */
export const GROK_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write'
export const GROK_OAUTH_ISSUER = 'https://auth.x.ai'
export const GROK_OAUTH_DISCOVERY_URL = `${GROK_OAUTH_ISSUER}/.well-known/openid-configuration`
export const GROK_OAUTH_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
export const GROK_PROTOCOL_MODES = Object.freeze({
  'openai.responses': Object.freeze(['native', 'reject']),
  'openai.chat': Object.freeze(['native', 'reject']),
  'openai.completions': Object.freeze(['reject']),
  'anthropic.messages': Object.freeze(['native', 'convert', 'reject']),
})

export const DEFAULT_GROK_ROUTING = Object.freeze({
  enabled: false,
  base_url: DEFAULT_GROK_BASE_URL,
  oauth: {
    authorize_url: '',
    token_url: '',
    client_id: '',
    redirect_uri: '',
    scope: '',
    extra_authorize_params: {},
    refresh_skew_sec: 300,
  },
  websocket: { enabled: false },
  protocols: {
    'openai.responses': { mode: 'native', enabled: true },
    'openai.chat': { mode: 'native', enabled: true },
    'openai.completions': { mode: 'reject', enabled: false },
    'anthropic.messages': { mode: 'reject', enabled: false },
  },
  clients: {
    official_codex: 'allow',
    openai_compatible: 'allow',
    claude_code: 'reject',
    unknown: 'allow',
  },
  quota: normalizeGrokQuotaPolicy(),
  billing: { background: true, min_interval_sec: 1800 },
  // Official /v1/settings `inference_idle_timeout_secs` (3600 on 1.0.70).
  inference: { idle_timeout_sec: 3600 },
})

/**
 * Background Grok Build billing reads (grok-refresh-monitor). The floor is 30 minutes on
 * purpose: the Grok CLI reads billing when someone looks, not around the clock. The panel's
 * refresh button always forces a read regardless of these values.
 */
export const GROK_BILLING_LIMITS = Object.freeze({ min_interval_sec: Object.freeze({ min: 1800, max: 86400 }) })

/** Silence allowed on a Grok stream before the hop is cut. Grok's own client waits an hour. */
export const GROK_INFERENCE_LIMITS = Object.freeze({ idle_timeout_sec: Object.freeze({ min: 30, max: 7200 }) })

function normalizeInference(raw) {
  const src = asObject(raw) || {}
  const { min, max } = GROK_INFERENCE_LIMITS.idle_timeout_sec
  const n = Number(src.idle_timeout_sec)
  return {
    idle_timeout_sec: Number.isInteger(n)
      ? Math.min(max, Math.max(min, n))
      : DEFAULT_GROK_ROUTING.inference.idle_timeout_sec,
  }
}

function asObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
}

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isLoopbackHttp(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * Operator token and authorize URLs. Discovery results stay on https x.ai.
 * Loopback is allowed so a local mock IdP can run without sending tokens to the internet.
 */
export function isGrokOauthEndpoint(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (isLoopbackHost(url.hostname)) return true
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && (host === 'x.ai' || host.endsWith('.x.ai'))
  } catch {
    return false
  }
}

function normalizeExtraParams(raw) {
  const src = asObject(raw) || {}
  const out = {}
  for (const [k, v] of Object.entries(src)) {
    const key = String(k).trim()
    if (!key || v == null || typeof v === 'object') continue
    out[key] = String(v)
  }
  return out
}

function normalizeOauth(raw) {
  const src = asObject(raw) || {}
  const skew = Number(src.refresh_skew_sec)
  return {
    authorize_url: str(src.authorize_url),
    token_url: str(src.token_url),
    client_id: str(src.client_id),
    redirect_uri: str(src.redirect_uri),
    scope: str(src.scope),
    extra_authorize_params: normalizeExtraParams(src.extra_authorize_params),
    refresh_skew_sec: Number.isInteger(skew) && skew >= 30 && skew <= 3600 ? skew : 300,
  }
}

/**
 * The chat proxy receives the slot's access token, so it is held to xAI's own hosts
 * like the OAuth endpoints: https on grok.com or x.ai.
 */
export function isGrokBaseUrl(value) {
  try {
    const url = new URL(String(value || ''))
    const host = url.hostname.toLowerCase()
    const xai = ['grok.com', 'x.ai'].some((domain) => host === domain || host.endsWith(`.${domain}`))
    return url.protocol === 'https:' && xai && !url.username && !url.password
  } catch {
    return false
  }
}

function normalizeBilling(raw) {
  const src = asObject(raw) || {}
  const { min, max } = GROK_BILLING_LIMITS.min_interval_sec
  const n = Number(src.min_interval_sec)
  return {
    background: src.background !== false,
    min_interval_sec: Number.isInteger(n)
      ? Math.min(max, Math.max(min, n))
      : DEFAULT_GROK_ROUTING.billing.min_interval_sec,
  }
}

function normalizeBaseUrl(raw) {
  const value = str(raw).replace(/\/+$/, '')
  return value && isGrokBaseUrl(value) ? value : DEFAULT_GROK_BASE_URL
}

export function normalizeGrokRouting(raw = {}) {
  const src = asObject(raw) || {}
  const protocols = {}
  for (const [key, modes] of Object.entries(GROK_PROTOCOL_MODES)) {
    const item = { ...DEFAULT_GROK_ROUTING.protocols[key], ...(asObject(src.protocols?.[key]) || {}) }
    const mode = modes.includes(item.mode) ? item.mode : 'reject'
    protocols[key] = { mode, enabled: item.enabled !== false && mode !== 'reject' }
  }
  const clients = { ...DEFAULT_GROK_ROUTING.clients, ...(asObject(src.clients) || {}) }
  for (const [key, value] of Object.entries(clients)) clients[key] = value === 'allow' ? 'allow' : 'reject'
  return {
    enabled: src.enabled === true,
    base_url: normalizeBaseUrl(src.base_url),
    oauth: normalizeOauth(src.oauth),
    websocket: { enabled: asObject(src.websocket)?.enabled === true },
    protocols,
    clients,
    quota: normalizeGrokQuotaPolicy(src.quota),
    billing: normalizeBilling(src.billing),
    inference: normalizeInference(src.inference),
  }
}

/** PUT /api/panel/routing strict checks for the `grok` section. */
export function validateGrokRoutingPatch(body = {}) {
  if (!asObject(body) || !Object.prototype.hasOwnProperty.call(body, 'grok')) return
  const grok = body.grok
  if (!asObject(grok)) throw typedError('grok 必须是对象', 'invalid_grok')
  if (Object.prototype.hasOwnProperty.call(grok, 'enabled') && typeof grok.enabled !== 'boolean') {
    throw typedError('grok.enabled 必须是布尔', 'invalid_grok')
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'base_url') && !isGrokBaseUrl(str(grok.base_url))) {
    throw typedError('grok.base_url 必须是 https://*.grok.com 或 https://*.x.ai', 'invalid_grok_base_url')
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'oauth')) {
    const oauth = grok.oauth
    if (!asObject(oauth)) throw typedError('grok.oauth 必须是对象', 'invalid_grok_oauth')
    for (const key of ['authorize_url', 'token_url']) {
      const value = str(oauth[key])
      if (value && !isGrokOauthEndpoint(value)) {
        throw typedError(`grok.oauth.${key} 必须是 https://*.x.ai 或本机回环地址`, 'invalid_grok_oauth')
      }
    }
    const redirect = str(oauth.redirect_uri)
    if (redirect && !isHttpsUrl(redirect) && !isLoopbackHttp(redirect)) {
      throw typedError('grok.oauth.redirect_uri 必须是 https 或本机回环地址', 'invalid_grok_oauth')
    }
    if (oauth.extra_authorize_params != null && !asObject(oauth.extra_authorize_params)) {
      throw typedError('grok.oauth.extra_authorize_params 必须是对象', 'invalid_grok_oauth')
    }
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'protocols')) {
    if (!asObject(grok.protocols)) throw typedError('grok.protocols 必须是对象', 'invalid_grok_protocols')
    for (const [key, item] of Object.entries(grok.protocols)) {
      const modes = GROK_PROTOCOL_MODES[key]
      if (!modes) throw typedError(`grok.protocols.${key} 不支持`, 'invalid_grok_protocols')
      if (item?.mode != null && !modes.includes(item.mode)) {
        throw typedError(`grok.protocols.${key}.mode 只能是 ${modes.join(' / ')}`, 'invalid_grok_protocols')
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'clients')) {
    if (!asObject(grok.clients)) throw typedError('grok.clients 必须是对象', 'invalid_grok_clients')
    for (const [key, value] of Object.entries(grok.clients)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_GROK_ROUTING.clients, key)) {
        throw typedError(`grok.clients.${key} 不支持`, 'invalid_grok_clients')
      }
      if (value !== 'allow' && value !== 'reject') {
        throw typedError(`grok.clients.${key} 只能是 allow / reject`, 'invalid_grok_clients')
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'billing')) {
    const billing = grok.billing
    if (!asObject(billing)) throw typedError('grok.billing 必须是对象', 'invalid_grok_billing')
    if (billing.background != null && typeof billing.background !== 'boolean') {
      throw typedError('grok.billing.background 必须是布尔', 'invalid_grok_billing')
    }
    if (billing.min_interval_sec != null) {
      const { min, max } = GROK_BILLING_LIMITS.min_interval_sec
      const n = billing.min_interval_sec
      if (!Number.isInteger(n) || n < min || n > max) {
        throw typedError(`grok.billing.min_interval_sec 必须是 ${min}–${max} 的整数（秒）`, 'invalid_grok_billing')
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'inference')) {
    const inference = grok.inference
    if (!asObject(inference)) throw typedError('grok.inference 必须是对象', 'invalid_grok_inference')
    if (inference.idle_timeout_sec != null) {
      const { min, max } = GROK_INFERENCE_LIMITS.idle_timeout_sec
      const n = inference.idle_timeout_sec
      if (!Number.isInteger(n) || n < min || n > max) {
        throw typedError(`grok.inference.idle_timeout_sec 必须是 ${min}–${max} 的整数（秒）`, 'invalid_grok_inference')
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'oauth') && grok.oauth?.refresh_skew_sec != null) {
    const skew = grok.oauth.refresh_skew_sec
    if (!Number.isInteger(skew) || skew < 30 || skew > 3600) {
      throw typedError('grok.oauth.refresh_skew_sec 必须是 30–3600 的整数（秒）', 'invalid_grok_oauth')
    }
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'quota')) {
    try {
      validateGrokQuotaPatch(grok.quota)
    } catch (e) {
      throw typedError(e.message, 'invalid_grok_quota')
    }
  }
}

export function grokRoutingOf(routing = {}) {
  return normalizeGrokRouting(asObject(routing)?.grok)
}

/**
 * Official client plus any operator overrides.
 * An empty token_url means "discover it"; that is not a configuration error.
 * An override is invalid unless it is https on x.ai (or a loopback mock). Redirect may be any https or loopback URL.
 */
export function grokOauthConfig(routing = {}) {
  const oauth = grokRoutingOf(routing).oauth
  const invalid = []
  if (oauth.authorize_url && !isGrokOauthEndpoint(oauth.authorize_url)) invalid.push('authorize_url')
  if (oauth.token_url && !isGrokOauthEndpoint(oauth.token_url)) invalid.push('token_url')
  if (oauth.redirect_uri && !isHttpsUrl(oauth.redirect_uri) && !isLoopbackHttp(oauth.redirect_uri)) {
    invalid.push('redirect_uri')
  }
  if (invalid.length) {
    return { ok: false, code: 'grok_oauth_not_configured', missing: invalid }
  }
  return {
    ok: true,
    config: {
      ...oauth,
      client_id: oauth.client_id || GROK_OAUTH_CLIENT_ID,
      scope: oauth.scope || GROK_OAUTH_SCOPE,
    },
  }
}

export function grokBaseUrl(routing = {}) {
  return grokRoutingOf(routing).base_url
}

export function isGrokProtocolAllowed(protocol, routing = {}) {
  const grok = grokRoutingOf(routing)
  if (!grok.enabled) return { ok: false, code: 'grok_disabled', mode: 'reject' }
  const entry = grok.protocols[protocol]
  if (!entry || entry.enabled === false || entry.mode === 'reject') {
    return { ok: false, code: 'protocol_not_allowed', mode: 'reject' }
  }
  return { ok: true, mode: entry.mode }
}
