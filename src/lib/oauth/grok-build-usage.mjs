/**
 * Grok Build account allowance.
 *
 * The installed Grok CLI 1.0.62 loads this from the chat proxy, not from
 * grok.com or api.x.ai. `GET /v1/billing?format=credits` is the shared weekly
 * pool (`creditUsagePercent`). `GET /v1/billing` is the monthly ledger.
 * grok.com/billing is the website and returns 404. xAI still does not publish
 * Claude-style 5h / 7d windows.
 */
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { persistGrokBuildUsage } from '../vm/grok-slot.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { isGrokVm } from '../vm/vm-kind.mjs'
import { callGrokKernel, grokKernelEnvelope, readGrokKernelJson } from '../transport/grok-kernel-client.mjs'
import { ensureGrokKernel, writeGrokKernelConfig } from '../transport/grok-kernel-supervisor.mjs'
import { DEFAULT_USAGE_PROBE } from './usage-probe-monitor.mjs'

export const GROK_BUILD_CREDITS_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
export const GROK_BUILD_LEDGER_URL = 'https://cli-chat-proxy.grok.com/v1/billing'
/** Weekly credits document. Kept under the old name for callers and tests. */
export const GROK_BUILD_BILLING_URL = GROK_BUILD_CREDITS_URL
/** Same freshness as Claude usage windows: `usage_probe.stale_sec`, default 5 minutes. */
export const GROK_BUILD_USAGE_STALE_MS = DEFAULT_USAGE_PROBE.stale_sec * 1000

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

/** First non-empty tier across the credits and ledger documents, top level or under `config`. */
function grokSubscriptionTierOf(...docs) {
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue
    const tier = text(doc.subscription_tier) || text(doc.subscriptionTier)
    if (tier) return tier
  }
  return null
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
    subscription_tier: grokSubscriptionTierOf(root, config, ledger, ledgerConfig),
    error: null,
  }
}

export function grokBuildUsageFresh(usage, now = Date.now(), staleMs = GROK_BUILD_USAGE_STALE_MS) {
  if (!usage) return false
  // A 404 with no numbers is not a usable sample. Retry on the next pass.
  if (usage.ok === false && grokCreditUsedPercent(usage.credit_usage_percent) == null) return false
  const probedAt = Date.parse(usage.probed_at || '')
  // A failed hop that still has a percent retries on the same cadence as Claude.
  return Number.isFinite(probedAt) && now - probedAt < staleMs
}

async function fetchGrokBuildDocument({ projectRoot, vm, query = '', forward }) {
  const call =
    forward ||
    (async (envelope) => {
      const ready = await ensureGrokKernel({ projectRoot, vmId: vm.id })
      if (!ready?.ok) return { kernelError: true, statusCode: 503, async *[Symbol.asyncIterator]() {} }
      // A JSON document, not a stream: the whole read shares one deadline.
      return callGrokKernel({ projectRoot, vmId: vm.id, envelope, signal: AbortSignal.timeout(60_000) })
    })
  let response
  try {
    response = await call(grokKernelEnvelope({ method: 'GET', path: '/v1/billing', query, purpose: 'billing' }))
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /aborted/i.test(String(error?.message || error))
    return fail(
      aborted ? 'timeout' : 'fetch_failed',
      aborted ? 'Grok Build 用量请求超时' : 'Grok Build 用量请求失败',
      502,
    )
  }
  const status = Number(response?.statusCode || response?.status) || 0
  const payload = await readGrokKernelJson(response).catch(() => null)
  if (response?.kernelError) {
    const code = String(payload?.error?.code || 'kernel_error')
    if (/credential|token|refresh|unauthorized/i.test(code)) {
      return fail('upstream_auth', 'Grok Build 账单需要重新登录', 401)
    }
    return fail('fetch_failed', 'Grok 出站内核没有返回账单', 502)
  }
  if (status === 401 || status === 403) {
    return fail('upstream_auth', 'Grok Build 账单需要重新登录', status)
  }
  if (status < 200 || status >= 300) {
    return fail('upstream_error', `Grok Build 账单返回 ${status || 0}`, status >= 400 && status < 500 ? status : 502)
  }
  return { ok: true, payload }
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
  forward,
  proxyUrl,
  now = Date.now(),
  staleMs = GROK_BUILD_USAGE_STALE_MS,
} = {}) {
  const vm = getVm(projectRoot, vmId)
  if (!vm || !isGrokVm(vm)) return fail('not_grok_slot', '只有 Grok 槽同步 Grok Build 用量', 400)
  const local = isLocalEgressProxy(vm.proxy)
  const onNode = !!vm.node_id
  const exitUrl = proxyUrl === undefined ? String(hostProxyUrlForVm(vm) || '') : String(proxyUrl || '')
  // A node slot's local egress is that node's route. Empty URL must not dial from here.
  if (!exitUrl && !(local && !onNode) && !forward) return fail('proxy_required', 'Grok 槽未绑定出口', 400)
  const stored = vm.grok?.build_usage
  const freshFor = Number(staleMs) > 0 ? Number(staleMs) : GROK_BUILD_USAGE_STALE_MS
  if (!force && grokBuildUsageFresh(stored, now, freshFor)) {
    return { ok: true, skipped: true, usage: stored, source: 'grok-build' }
  }
  writeGrokKernelConfig(projectRoot, vm, {
    proxyUrl: local && !onNode ? '' : exitUrl,
    proxyRequired: !(local && !onNode),
    routing,
  })
  const credits = await fetchGrokBuildDocument({
    projectRoot,
    vm,
    query: 'format=credits',
    forward,
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
    projectRoot,
    vm,
    forward,
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
