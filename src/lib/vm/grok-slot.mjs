/**
 * Grok slot metadata. Tokens stay in vms/<id>/grok-credentials.json (0600);
 * vm.json only carries the display bag `vm.grok` (never token text).
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, readJsonCached } from './vm-file.mjs'
import { grokIdentityFromTokens, grokTokenTier } from '../oauth/grok-oauth.mjs'

export function grokCredentialPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'grok-credentials.json')
}

export function readGrokAccounts(projectRoot, vmId) {
  try {
    const raw = readJsonCached(grokCredentialPath(projectRoot, vmId))
    return Array.isArray(raw?.accounts) ? raw.accounts : []
  } catch {
    return []
  }
}

export function readGrokAccount(projectRoot, vmId) {
  return readGrokAccounts(projectRoot, vmId)[0] || null
}

export function writeGrokAccounts(projectRoot, vmId, accounts) {
  if (!projectRoot || !vmId) throw new Error('projectRoot and vmId required')
  const file = grokCredentialPath(projectRoot, vmId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  atomicWriteJson(file, { accounts: Array.isArray(accounts) ? accounts : [] }, { mode: 0o600 })
}

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function expiresAtOf(src) {
  const at = Number(src?.expires_at ?? src?.expiresAt)
  if (Number.isFinite(at) && at > 0) return at < 1e12 ? at * 1000 : at
  if (typeof src?.expires_at === 'string' && Number.isFinite(Date.parse(src.expires_at))) {
    return Date.parse(src.expires_at)
  }
  const inSec = Number(src?.expires_in ?? src?.expiresIn)
  return Number.isFinite(inSec) && inSec > 0 ? Date.now() + inSec * 1000 : null
}

function findTokenObject(value) {
  const pending = [value]
  const seen = new Set()
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    if (str(current.access_token || current.accessToken) || str(current.refresh_token || current.refreshToken)) {
      return current
    }
    pending.push(...(Array.isArray(current) ? current : Object.values(current)))
  }
  return null
}

function rejectForeignSecret(text) {
  if (/^sk-ant-/i.test(text)) throw fail('wrong_platform', '这是 Claude 凭证，不能导入 Grok 槽位')
  if (/^xai-/i.test(text)) {
    throw fail('api_key_not_supported', 'xAI API Key 不是 OAuth 凭证，请在「API 端点」中添加')
  }
}

/**
 * Normalize an import payload. `mode` is access_token | refresh_token | json.
 * The OAuth callback flow goes through grok-oauth.mjs, not here.
 */
export function parseGrokCredentialInput(input, mode = 'json') {
  if (mode === 'access_token' || mode === 'refresh_token') {
    const text = str(typeof input === 'string' ? input : input?.[mode])
    if (!text)
      throw fail('credential_required', mode === 'access_token' ? '请粘贴 access_token' : '请粘贴 refresh_token')
    rejectForeignSecret(text)
    return mode === 'access_token'
      ? { access_token: text, refresh_token: '', id_token: '', expires_at: null }
      : { access_token: '', refresh_token: text, id_token: '', expires_at: null }
  }
  let doc = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) throw fail('credential_required', '请粘贴凭证 JSON')
    rejectForeignSecret(text)
    try {
      doc = JSON.parse(text)
    } catch {
      throw fail('invalid_json', '凭证不是合法 JSON')
    }
  }
  const tok = findTokenObject(doc)
  if (!tok) throw fail('credential_required', 'JSON 中没有 access_token 或 refresh_token')
  const access = str(tok.access_token || tok.accessToken)
  const refresh = str(tok.refresh_token || tok.refreshToken)
  rejectForeignSecret(access || refresh)
  return {
    access_token: access,
    refresh_token: refresh,
    id_token: str(tok.id_token || tok.idToken),
    expires_at: expiresAtOf(tok),
  }
}

export function upsertGrokAccount(projectRoot, vmId, patch = {}, { replaceCredentials = false } = {}) {
  const accounts = readGrokAccounts(projectRoot, vmId)
  const previous = replaceCredentials ? {} : { ...(accounts[0] || {}) }
  const next = { ...previous, ...patch, updated_at: new Date().toISOString() }
  for (const key of ['access_token', 'refresh_token', 'id_token']) next[key] = str(next[key])
  const identity = grokIdentityFromTokens(next)
  next.email = str(patch.email) || identity.email || previous.email || null
  next.account_id = str(patch.account_id) || identity.account_id || previous.account_id || null
  next.id = next.email || next.account_id || 'grok'
  if (!accounts.length) accounts.push(next)
  else accounts[0] = next
  writeGrokAccounts(projectRoot, vmId, accounts)
  return next
}

/** Display bag stored on vm.json. Never contains token text. */
export function grokBagFromAccount(account = {}, previous = {}) {
  return {
    ...previous,
    has_access: !!str(account.access_token),
    has_refresh: !!str(account.refresh_token),
    email: account.email || null,
    account_id: account.account_id || null,
    expires_at: Number(account.expires_at) || null,
  }
}

/** Patch vm.grok in vms/<id>.json. `fn` receives a copy of the bag and returns the next bag. */
export function patchGrokBag(projectRoot, vmId, fn) {
  if (!projectRoot || !vmId) throw new Error('projectRoot and vmId required')
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  let vm
  try {
    vm = readJsonCached(file)
  } catch {
    return null
  }
  if (!vm || typeof vm !== 'object') return null
  vm = { ...vm }
  const bag = vm.grok && typeof vm.grok === 'object' ? { ...vm.grok } : {}
  vm.grok = fn(bag) || bag
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function persistGrokCredentialState(projectRoot, vmId, account, extra = {}) {
  return patchGrokBag(projectRoot, vmId, (bag) => ({ ...grokBagFromAccount(account, bag), ...extra }))
}

/** Upstream 429 park; read by the Grok slot pool. `until` null clears it. */
export function persistGrokRateLimit(projectRoot, vmId, { until = null, reason = null } = {}) {
  return patchGrokBag(projectRoot, vmId, (bag) => {
    if (!until) {
      delete bag.limited_until
      delete bag.limited_reason
      return bag
    }
    return { ...bag, limited_until: Number(until), limited_reason: String(reason || 'rate_limited') }
  })
}

function finiteOrNull(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

/** Panel fields for a Grok Build billing sample. Never includes a token. */
export function publicGrokBuildUsage(bag = {}) {
  const usage = bag.build_usage
  if (!usage || typeof usage !== 'object') return null
  return {
    probed_at: typeof usage.probed_at === 'string' ? usage.probed_at : null,
    ok: usage.ok !== false,
    credit_usage_percent: finiteOrNull(usage.credit_usage_percent),
    period_start: usage.period_start || null,
    period_end: usage.period_end || null,
    monthly_limit: finiteOrNull(usage.monthly_limit),
    included_used: finiteOrNull(usage.included_used),
    total_used: finiteOrNull(usage.total_used),
    on_demand_cap: finiteOrNull(usage.on_demand_cap),
    on_demand_used: finiteOrNull(usage.on_demand_used),
    prepaid_balance: finiteOrNull(usage.prepaid_balance),
    on_demand_enabled: usage.on_demand_enabled === true ? true : usage.on_demand_enabled === false ? false : null,
    subscription_tier: str(usage.subscription_tier) || null,
    error: str(usage.error) || null,
    message: str(usage.message) || null,
  }
}

const BUILD_USAGE_KEEP = [
  'credit_usage_percent',
  'period_start',
  'period_end',
  'monthly_limit',
  'included_used',
  'total_used',
  'on_demand_cap',
  'on_demand_used',
  'prepaid_balance',
  'on_demand_enabled',
  'subscription_tier',
]

/** Store a Grok Build billing sample. A failed hop keeps the last good numbers. */
export function persistGrokBuildUsage(projectRoot, vmId, usage = {}) {
  return patchGrokBag(projectRoot, vmId, (bag) => {
    const previous = bag.build_usage && typeof bag.build_usage === 'object' ? bag.build_usage : {}
    const next = { ...previous, ...usage }
    if (usage.ok === false) {
      for (const key of BUILD_USAGE_KEEP) {
        if (previous[key] != null) next[key] = previous[key]
      }
    }
    return { ...bag, build_usage: next }
  })
}

export function summarizeGrokSlot(projectRoot, vm = {}, now = Date.now()) {
  const account = projectRoot && vm?.id ? readGrokAccount(projectRoot, vm.id) : null
  const bag = vm.grok && typeof vm.grok === 'object' ? vm.grok : {}
  const hasAccess = !!(str(account?.access_token) || bag.has_access)
  const hasRefresh = !!(str(account?.refresh_token) || bag.has_refresh)
  const expiresAt = Number(account?.expires_at || bag.expires_at) || null
  const limitedUntil = Number(bag.limited_until) > now ? Number(bag.limited_until) : null
  return {
    platform: 'xai',
    family: 'grok',
    has_token: hasRefresh || (hasAccess && (expiresAt == null || expiresAt > now)),
    has_refresh: hasRefresh,
    email: account?.email || bag.email || null,
    account_id: account?.account_id || bag.account_id || null,
    expires_at: expiresAt,
    auth_error: bag.auth_error || null,
    limited_until: limitedUntil,
    limited_reason: limitedUntil ? bag.limited_reason || null : null,
    last_refresh_at: bag.last_refresh_at || null,
    build_usage: publicGrokBuildUsage(bag),
    token_tier: grokTokenTier(account?.access_token),
  }
}
