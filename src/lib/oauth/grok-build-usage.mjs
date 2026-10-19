/**
 * Grok Build account allowance.
 *
 * The installed Grok CLI 1.0.62 loads this from the chat proxy, not from
 * grok.com or api.x.ai. `GET /v1/billing?format=credits` is the shared weekly
 * pool (`creditUsagePercent`). `GET /v1/billing` is the monthly ledger.
 * grok.com/billing is the website and returns 404. xAI still does not publish
 * Claude-style 5h / 7d windows.
 */
import { grokCliIdentityHeaders } from '../protocol/grok-client.mjs'
import { ensureGrokAccessToken } from './grok-token.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { persistGrokBuildUsage, readGrokAccount } from '../vm/grok-slot.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { isGrokVm } from '../vm/vm-kind.mjs'
import { makeProxyFetch, readFetchBody } from '../transport/proxy-fetch.mjs'

export const GROK_BUILD_CREDITS_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
export const GROK_BUILD_LEDGER_URL = 'https://cli-chat-proxy.grok.com/v1/billing'
/** Weekly credits document. Kept under the old name for callers and tests. */
export const GROK_BUILD_BILLING_URL = GROK_BUILD_CREDITS_URL
export const GROK_BUILD_USAGE_STALE_MS = 15 * 60 * 1000

function fail(error, message, status = 400) {
  return { ok: false, error, message, status }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function money(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('val' in value || 'value' in value) return money(value.val ?? value.value)
  }
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

/**
 * CLI field `creditUsagePercent`. Values above 1 are already percent points.
 * 0..1 is a fraction (1 means the pool is full).
 */
export function grokCreditUsedPercent(value) {
  if (value == null || value === '') return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return null
  const points = amount <= 1 ? amount * 100 : amount
  return Math.min(100, points)
}

function timeOf(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value
    return new Date(millis).toISOString()
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function flag(value) {
  if (value === true || value === false) return value
  return null
}

function latestHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return null
  let best = null
  let bestScore = null
  for (const row of history) {
    const cycle = row?.billingCycle || row?.billing_cycle
    const year = Number(cycle?.year)
    const month = Number(cycle?.month)
    if (!Number.isFinite(year) || !Number.isFinite(month)) continue
    const score = year * 12 + month
    if (bestScore == null || score >= bestScore) {
      best = row
      bestScore = score
    }
  }
  return best || history[history.length - 1] || null
}

function configOf(payload) {
  const root = payload && typeof payload === 'object' ? payload : {}
  return root.config && typeof root.config === 'object' ? root.config : root
}

/**
 * Normalize a BillingConfigResponse. `ledger` is the `/v1/billing` document,
 * which carries the monthly limit the credits document does not.
 * Returns null when nothing usable is present.
 */
export function parseGrokBuildBilling(payload, ledger = null) {
  const root = payload && typeof payload === 'object' ? payload : {}
  const config = configOf(payload)
  const ledgerConfig = ledger ? configOf(ledger) : null
  const period = config.currentPeriod || config.current_period || {}
  const history = latestHistory(config.history) || latestHistory(ledgerConfig?.history)
  const credit = grokCreditUsedPercent(config.creditUsagePercent ?? config.credit_usage_percent)
  const monthly = money(
    config.monthlyLimit ?? config.monthly_limit ?? ledgerConfig?.monthlyLimit ?? ledgerConfig?.monthly_limit,
  )
  if (credit == null && monthly == null) return null
  return {
    ok: true,
    credit_usage_percent: credit,
    period_start: timeOf(period.start ?? config.billingPeriodStart ?? config.billing_period_start),
    period_end: timeOf(period.end),
    monthly_limit: monthly,
    included_used: money(history?.includedUsed ?? history?.included_used),
    total_used: money(history?.totalUsed ?? history?.total_used),
    on_demand_cap: money(config.onDemandCap ?? config.on_demand_cap ?? ledgerConfig?.onDemandCap),
    on_demand_used: money(config.onDemandUsed ?? config.on_demand_used ?? ledgerConfig?.onDemandUsed),
    prepaid_balance: money(config.prepaidBalance ?? config.prepaid_balance ?? ledgerConfig?.prepaidBalance),
    on_demand_enabled: flag(root.on_demand_enabled ?? root.onDemandEnabled ?? config.onDemandEnabled),
    subscription_tier: text(root.subscription_tier || root.subscriptionTier) || null,
    error: null,
  }
}

export function grokBuildUsageFresh(usage, now = Date.now(), staleMs = GROK_BUILD_USAGE_STALE_MS) {
  if (!usage) return false
  // A 404 with no numbers is not a usable sample. Retry on the next pass.
  if (usage.ok === false && grokCreditUsedPercent(usage.credit_usage_percent) == null) return false
  const probedAt = Date.parse(usage.probed_at || '')
  // A failed hop is also a sample: retry on the same 15 minute cadence.
  return Number.isFinite(probedAt) && now - probedAt < staleMs
}

async function fetchGrokBuildDocument({ url, accessToken, proxyUrl, fetchImpl }) {
  const fetchFn = fetchImpl || makeProxyFetch(proxyUrl, 20_000)
  let response
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...grokCliIdentityHeaders(),
      },
    })
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /aborted/i.test(String(error?.message || error))
    return fail(
      aborted ? 'timeout' : 'fetch_failed',
      aborted ? 'Grok Build 用量请求超时' : 'Grok Build 用量请求失败',
      502,
    )
  }
  const status = Number(response?.status) || 0
  const payload = await readFetchBody(response)
  if (status === 401 || status === 403) {
    return fail('upstream_auth', 'Grok Build 账单需要重新登录', status)
  }
  if (status < 200 || status >= 300) {
    return fail('upstream_error', `Grok Build 账单返回 ${status || 0}`, status >= 400 && status < 500 ? status : 502)
  }
  return { ok: true, payload }
}

function usableAccess(projectRoot, vmId, now) {
  const account = readGrokAccount(projectRoot, vmId)
  const access = text(account?.access_token)
  if (!access) return ''
  const expiresAt = Number(account?.expires_at) || 0
  if (expiresAt && expiresAt <= now) return ''
  return access
}

/**
 * Read Grok Build billing for one slot and store it on `vm.grok.build_usage`.
 * A fresh sample is reused unless `force` is set. A failed hop keeps the last
 * good numbers.
 */
export async function queryGrokBuildUsage({
  projectRoot,
  vmId,
  routing = {},
  force = false,
  fetchImpl,
  proxyUrl,
  now = Date.now(),
} = {}) {
  const vm = getVm(projectRoot, vmId)
  if (!vm || !isGrokVm(vm)) return fail('not_grok_slot', '只有 Grok 槽同步 Grok Build 用量', 400)
  const local = isLocalEgressProxy(vm.proxy)
  const exitUrl = proxyUrl === undefined ? String(hostProxyUrlForVm(vm) || '') : String(proxyUrl || '')
  if (!exitUrl && !local && !fetchImpl) return fail('proxy_required', 'Grok 槽未绑定出口', 400)
  const stored = vm.grok?.build_usage
  if (!force && grokBuildUsageFresh(stored, now)) {
    return { ok: true, skipped: true, usage: stored, source: 'grok-build' }
  }
  const token = await ensureGrokAccessToken({
    projectRoot,
    vm,
    routing,
    proxyUrl: exitUrl,
    fetchImpl,
  })
  const access = token.ok ? token.access_token : usableAccess(projectRoot, vmId, now)
  if (!access) {
    return fail(token.code || 'grok_no_credential', 'Grok 凭证不可用，请重新导入', 401)
  }
  const credits = await fetchGrokBuildDocument({
    url: GROK_BUILD_CREDITS_URL,
    accessToken: access,
    proxyUrl: exitUrl,
    fetchImpl,
  })
  const probedAt = new Date(now).toISOString()
  if (!credits.ok) {
    persistGrokBuildUsage(projectRoot, vmId, {
      ok: false,
      error: credits.error,
      message: credits.message,
      probed_at: probedAt,
    })
    return credits
  }
  const ledger = await fetchGrokBuildDocument({
    url: GROK_BUILD_LEDGER_URL,
    accessToken: access,
    proxyUrl: exitUrl,
    fetchImpl,
  })
  const parsed = parseGrokBuildBilling(credits.payload, ledger.ok ? ledger.payload : null)
  if (!parsed) {
    persistGrokBuildUsage(projectRoot, vmId, {
      ok: false,
      error: 'billing_unparsed',
      message: 'Grok Build 账单里没有用量',
      probed_at: probedAt,
    })
    return fail('billing_unparsed', 'Grok Build 账单里没有用量', 502)
  }
  const usage = { ...parsed, ok: true, error: null, message: null, probed_at: probedAt }
  persistGrokBuildUsage(projectRoot, vmId, usage)
  return { ok: true, usage, source: 'grok-build' }
}
