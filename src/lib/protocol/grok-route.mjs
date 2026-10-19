/**
 * Grok (xAI) routing. Claude and Codex traffic never read this object.
 * OAuth endpoints are operator configuration; nothing here guesses xAI URLs.
 */
import { normalizeGrokQuotaPolicy, validateGrokQuotaPatch } from '../pool/openai-quota-policy.mjs'

export const DEFAULT_GROK_BASE_URL = 'https://api.x.ai'
export const GROK_PROTOCOL_MODES = Object.freeze({
  'openai.responses': Object.freeze(['native', 'reject']),
  'openai.chat': Object.freeze(['native', 'reject']),
  'openai.completions': Object.freeze(['reject']),
  'anthropic.messages': Object.freeze(['native', 'convert', 'reject']),
})
export const GROK_OAUTH_REQUIRED = Object.freeze(['authorize_url', 'token_url', 'client_id', 'redirect_uri'])

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
})

function asObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
}

function typedError(message, code) {
  const error = new TypeError(message)
  error.code = code
  return error
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

function normalizeBaseUrl(raw) {
  const value = str(raw).replace(/\/+$/, '')
  return value && isHttpsUrl(value) ? value : DEFAULT_GROK_BASE_URL
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
  if (Object.prototype.hasOwnProperty.call(grok, 'base_url') && !isHttpsUrl(str(grok.base_url))) {
    throw typedError('grok.base_url 必须是 https 地址', 'invalid_grok_base_url')
  }
  if (Object.prototype.hasOwnProperty.call(grok, 'oauth')) {
    const oauth = grok.oauth
    if (!asObject(oauth)) throw typedError('grok.oauth 必须是对象', 'invalid_grok_oauth')
    for (const key of ['authorize_url', 'token_url']) {
      const value = str(oauth[key])
      if (value && !isHttpsUrl(value)) throw typedError(`grok.oauth.${key} 必须是 https 地址`, 'invalid_grok_oauth')
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
 * Resolved OAuth client config, or the list of missing fields.
 * Callers must fail closed (503 grok_oauth_not_configured) on !ok.
 */
export function grokOauthConfig(routing = {}) {
  const oauth = grokRoutingOf(routing).oauth
  const missing = GROK_OAUTH_REQUIRED.filter((key) => !oauth[key])
  const invalid = []
  if (oauth.authorize_url && !isHttpsUrl(oauth.authorize_url)) invalid.push('authorize_url')
  if (oauth.token_url && !isHttpsUrl(oauth.token_url)) invalid.push('token_url')
  if (oauth.redirect_uri && !isHttpsUrl(oauth.redirect_uri) && !isLoopbackHttp(oauth.redirect_uri)) {
    invalid.push('redirect_uri')
  }
  if (missing.length || invalid.length) {
    return { ok: false, code: 'grok_oauth_not_configured', missing: [...missing, ...invalid] }
  }
  return { ok: true, config: oauth }
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
