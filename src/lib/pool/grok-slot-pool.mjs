/**
 * Grok slot pool. The Claude pool never sees these VMs (`evaluateSlotGate` → `grok_vm`).
 * Ordering reuses the OpenAI account selector on Grok's own runtime instance; there are no
 * upstream 5h/7d windows, only upstream 429 parks and local seat limits.
 */
import { isGrokVm } from '../vm/vm-kind.mjs'
import { isLeftoverQuotaScheduleOff } from './availability.mjs'
import { orderOpenAIAccounts } from './openai-account-selector.mjs'
import { grokRuntime } from './openai-account-runtime.mjs'
import { modelMatchesAllowlist } from './slot-model-gate.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { activeHoursOf, evaluateActiveHours } from './active-hours.mjs'
import { effectiveOpenAIPolicy, normalizeGrokQuotaPolicy } from './openai-quota-policy.mjs'

const HARD_UNAVAILABLE = new Set(['dead', 'error', 'disabled'])
const DEFAULT_PARK_MS = 30_000
const MAX_PARK_MS = 60 * 60 * 1000

function bagOf(vm) {
  return vm?.grok && typeof vm.grok === 'object' ? vm.grok : {}
}

function authErrorOf(vm) {
  return vm?.grok_auth_error || bagOf(vm).auth_error || null
}

function limitedUntilOf(vm) {
  const at = Number(vm?.grok_limited_until ?? bagOf(vm).limited_until)
  return Number.isFinite(at) && at > 0 ? at : null
}

function expiresAtOf(vm) {
  const at = Number(vm?.expires_at ?? bagOf(vm).expires_at)
  return Number.isFinite(at) && at > 0 ? at : null
}

export function isGrokSlotReady(vm, now = Date.now()) {
  if (!vm || !isGrokVm(vm)) return false
  if (proxyBlockedReason(vm.proxy)) return false
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return false
  if (!vm.has_token) return false
  if (authErrorOf(vm)) return false
  const exp = expiresAtOf(vm)
  if (exp && exp <= now && !vm.has_refresh) return false
  return !HARD_UNAVAILABLE.has(String(vm.status || '').toLowerCase())
}

export function isGrokSlotParked(vm, now = Date.now()) {
  const until = limitedUntilOf(vm)
  return until != null && until > now
}

/** Panel allowlist on a Grok slot. No model or no list means allowed. */
export function grokSlotAllowsModel(vm, model) {
  if (!model) return true
  return modelMatchesAllowlist(model, vm?.allowed_models ?? vm?.policy?.allowed_models)
}

export function grokAccountStatus(vm, now = Date.now()) {
  if (!vm || !isGrokVm(vm)) return 'error'
  if (proxyBlockedReason(vm.proxy)) return 'disabled'
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return 'disabled'
  const status = String(vm.status || '').toLowerCase()
  if (status === 'disabled') return 'disabled'
  if (status === 'dead' || status === 'error') return 'error'
  if (!vm.has_token || authErrorOf(vm)) return 'error'
  if (grokRuntime.accountHold(vm.id, now)) return 'cooldown'
  if (isGrokSlotParked(vm, now)) return 'quota_exhausted'
  return 'normal'
}

export function grokAccountCandidate(vm, now = Date.now(), signals = null, policy = null) {
  const runtime = signals || grokRuntime.signals(vm?.id, now)
  const effective = effectiveOpenAIPolicy(vm, normalizeGrokQuotaPolicy(policy))
  return {
    id: vm.id,
    weight: Number(vm?.policy?.weight ?? vm?.weight ?? 1) || 1,
    concurrency: effective.max_concurrency,
    maxRpm: effective.max_rpm,
    maxSessions: effective.max_sessions,
    rpmCount: runtime.rpmCount || 0,
    rpmResetAt: runtime.rpmResetAt ?? null,
    status: grokAccountStatus(vm, now),
    inFlight: runtime.inFlight || 0,
    lastStartedAt: runtime.lastStartedAt ?? null,
    quotaResetAt: limitedUntilOf(vm),
    quotaRemainingRank: null,
    failureRateBps: runtime.failureRateBps || 0,
    firstOutputLatencyMs: runtime.firstOutputLatencyMs ?? null,
  }
}

/** Ready slots first, 429-parked slots last (earliest release first). */
export function pickGrokSlots(vms, { pin = null, now = Date.now(), model = null } = {}) {
  const list = Array.isArray(vms) ? vms : []
  if (pin) {
    const vm = list.find((item) => item?.id === pin) || null
    if (!vm || !isGrokVm(vm)) return { error: 'platform_mismatch', pin, ids: [], ready: [], parked: [] }
    const blocked = proxyBlockedReason(vm.proxy)
    if (blocked) return { error: blocked, pin, ids: [], ready: [], parked: [] }
    return { ids: [vm.id], pin, ready: [vm.id], parked: [] }
  }
  const ready = []
  const parked = []
  const resting = []
  let restUntil = null
  for (const vm of list) {
    if (!isGrokSlotReady(vm, now)) continue
    const rest = evaluateActiveHours(activeHoursOf(vm), now, vm.timezone)
    if (!rest.active) {
      resting.push(vm.id)
      if (grokSlotAllowsModel(vm, model)) restUntil = restUntil == null ? rest.until : Math.min(restUntil, rest.until)
      continue
    }
    if (isGrokSlotParked(vm, now)) parked.push(vm)
    else ready.push(vm)
  }
  ready.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  parked.sort((a, b) => limitedUntilOf(a) - limitedUntilOf(b) || String(a.id).localeCompare(String(b.id)))
  const ids = [...ready, ...parked].map((vm) => vm.id)
  if (!ids.length) {
    if (restUntil != null) return { error: 'pool_resting', retryAt: restUntil, ids: [], ready: [], parked: [], resting }
    return { error: 'no_grok_vm', ids: [], ready: [], parked: [], resting }
  }
  return { ids, ready: ready.map((vm) => vm.id), parked: parked.map((vm) => vm.id), resting }
}

function withModelAllowed(picked, byId, model) {
  if (!model) return picked
  const keep = (id) => grokSlotAllowsModel(byId.get(id), model)
  const ids = picked.ids.filter(keep)
  if (!ids.length) return { error: 'model_not_allowed', ids: [], ready: [], parked: [] }
  return { ...picked, ids, ready: (picked.ready || []).filter(keep), parked: (picked.parked || []).filter(keep) }
}

/** Distinct conversation windows on a Grok slot. 0 = off. */
export function grokMaxSessions(vm, policy = null) {
  const n = effectiveOpenAIPolicy(vm, normalizeGrokQuotaPolicy(policy)).max_sessions
  return n > 0 ? Math.round(n) : 0
}

function rpmRetryAt(candidates, now) {
  const times = candidates
    .filter((c) => c.status === 'normal' && c.maxRpm > 0 && c.rpmCount >= c.maxRpm && c.inFlight < c.concurrency)
    .map((c) => Number(c.rpmResetAt))
    .filter((t) => Number.isFinite(t) && t > now)
  return times.length ? Math.min(...times) : null
}

function holdRetryAt(candidates, now) {
  const times = candidates
    .map((candidate) => grokRuntime.accountHold(candidate.id, now)?.until)
    .filter((until) => Number.isFinite(until) && until > now)
  return times.length ? Math.min(...times) : null
}

/**
 * Same contract as orderCodexSessionSlots: `home` is the live bound slot, only it owes the
 * conversation a `max_sessions` window, and `boundState` explains why affinity was lost.
 */
export function orderGrokSessionSlots(
  vms,
  {
    pin = null,
    boundVmId = null,
    sessionKey = null,
    sessionLimit = null,
    quotaPolicy = null,
    idleMin = 5,
    now = Date.now(),
    strategy = 'smart',
    requestIntervalMs = 0,
    roundRobinCursor = null,
    model = null,
    excluded = null,
  } = {},
) {
  const list = Array.isArray(vms) ? vms : []
  const byId = new Map(list.map((vm) => [vm.id, vm]))
  const policy = normalizeGrokQuotaPolicy(quotaPolicy)
  const found = pickGrokSlots(list, { pin, now, model })
  const boundResting = !!boundVmId && (found.resting || []).includes(boundVmId)
  const picked = found.error ? found : withModelAllowed(found, byId, model)
  if (picked.error) {
    return { ...picked, sticky: false, boundState: boundResting ? 'resting' : undefined, candidates: [] }
  }
  const pool = picked.ids.filter((id) => !excluded?.has(id))
  if (!pool.length)
    return { error: 'candidates_exhausted', ids: [], ready: [], parked: [], sticky: false, candidates: [] }
  if (pin) {
    return {
      ...picked,
      ids: pool,
      sticky: false,
      candidates: pool.map((id) => grokAccountCandidate(byId.get(id), now, null, policy)),
    }
  }
  const home =
    boundVmId && pool.includes(boundVmId) && grokAccountStatus(byId.get(boundVmId), now) === 'normal' ? boundVmId : null
  const boundState = boundVmId
    ? home
      ? 'live'
      : excluded?.has(boundVmId)
        ? 'excluded'
        : boundResting
          ? 'resting'
          : 'gone'
    : null
  const claimsWindow = (id) => !!sessionKey && (!home || id === home)
  const accepts = (id) => {
    if (!claimsWindow(id) || typeof sessionLimit?.canAccept !== 'function') return true
    const cap = grokMaxSessions(byId.get(id), policy)
    if (!cap) return true
    return sessionLimit.canAccept(id, sessionKey, { max: cap, idleMin, now }).ok !== false
  }
  const ids = pool.filter(accepts)
  if (!ids.length) {
    return { error: 'session_window_full', ids: [], ready: [], parked: [], sticky: false, boundState, candidates: [] }
  }
  const cursor = roundRobinCursor == null ? grokRuntime.readCursor() : roundRobinCursor
  const candidates = ids.map((id) => grokAccountCandidate(byId.get(id), now, null, policy))
  const ordered = orderOpenAIAccounts(candidates, {
    strategy,
    now,
    requestIntervalMs,
    preferredAccountId: home && ids.includes(home) ? home : null,
    preferredOverridesWeight: true,
    roundRobinCursor: cursor,
  })
  // A live home that is only out of seats stays the only candidate. Sending the
  // same conversation to another subscription rewrites the prompt cache there.
  const homeWaiting =
    !!home &&
    ordered.preferred === 'blocked' &&
    (ordered.blocker === 'concurrency_limit' ||
      ordered.blocker === 'rpm_limit' ||
      ordered.blocker === 'request_interval')
  if (homeWaiting) {
    const homeCandidate = candidates.find((candidate) => candidate.id === home)
    return {
      ...picked,
      ids: [home],
      ready: (picked.ready || []).includes(home) ? [home] : [],
      parked: (picked.parked || []).filter((id) => id === home),
      sticky: true,
      affinity: 'wait',
      strategy,
      boundState,
      home,
      candidates: homeCandidate ? [homeCandidate] : [],
    }
  }
  if (!ordered.ids.length) {
    const statuses = ids.map((id) => grokAccountStatus(byId.get(id), now))
    const quotaExhausted = statuses.length > 0 && statuses.every((status) => status === 'quota_exhausted')
    const retryAt = quotaExhausted
      ? Math.min(...ids.map((id) => limitedUntilOf(byId.get(id)) || Infinity))
      : rpmRetryAt(candidates, now) || holdRetryAt(candidates, now)
    return {
      error: quotaExhausted ? 'quota_exhausted' : 'capacity_unavailable',
      retryAt: Number.isFinite(retryAt) ? retryAt : null,
      ids: [],
      ready: [],
      parked: picked.parked || [],
      sticky: false,
      boundState,
      home,
      candidates: [],
    }
  }
  if (roundRobinCursor == null) grokRuntime.bumpCursor()
  const sticky = ordered.preferred === 'hit' && ordered.ids[0] === boundVmId
  return {
    ...picked,
    ids: ordered.ids,
    ready: ordered.ids.filter((id) => (picked.ready || []).includes(id)),
    parked: (picked.parked || []).filter((id) => ordered.ids.includes(id)),
    sticky,
    strategy,
    boundState,
    home,
    candidates: ordered.ids.map((id) => candidates.find((candidate) => candidate.id === id)),
  }
}

/**
 * Claim the conversation on the account this attempt just took.
 * A key another in-flight request already claimed wins; the caller must follow it.
 * @returns {string} account id the conversation has to use
 */
export function pinGrokConversation(stickyRouter, { sessionKey = null, stickyKeys = null } = {}, vmId) {
  if (!stickyRouter?.bind || !sessionKey || !vmId) return vmId || ''
  const keys = stickyKeys?.length ? stickyKeys : [sessionKey]
  for (const key of keys) {
    const hit = stickyRouter.resolve?.(key)
    if (hit?.vmId) return hit.vmId
  }
  const payload = { accountId: vmId, vmId }
  for (const key of keys) stickyRouter.bind(key, payload, { countHit: false })
  return vmId
}

/** Replayable on another seat: transport, auth, 429, and uncommitted server errors. */
export function isGrokFailoverError(result) {
  if (!result || result.ok === true || result.committed === true) return false
  const status = Number(result.status) || 0
  const code = String(result.body?.error?.code || result.error_code || '')
  const message = String(result.body?.error?.message || result.error || '')
  if (
    status !== 401 &&
    /content_policy|usage_policy|refusal|guard|invalid_request|invalid_argument|context_length/i.test(
      `${code} ${message}`,
    )
  )
    return false
  if (result.kernelError === true || result.transportError === true || status === 0) return true
  if (status === 401 || status === 403 || status === 408 || status === 429) return true
  return status === 500 || status === 502 || status === 503 || status === 504
}

/**
 * Park window for an upstream 429: Retry-After (seconds or HTTP-date), then x-ratelimit-reset-*
 * (seconds, `1m30s`, or epoch). Default 30 s, capped at 1 h.
 */
export function parkUntilFromHeaders(headers = {}, now = Date.now()) {
  const get = (name) => {
    const raw = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]
    return Array.isArray(raw) ? raw[0] : raw
  }
  const clamp = (ms) => now + Math.min(MAX_PARK_MS, Math.max(1000, ms))
  const retryAfter = String(get('retry-after') || '').trim()
  if (retryAfter) {
    const sec = Number(retryAfter)
    if (Number.isFinite(sec) && sec >= 0) return clamp(sec * 1000)
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return clamp(at - now)
  }
  let best = null
  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset']) {
    const ms = resetValueMs(String(get(name) || '').trim(), now)
    if (ms != null) best = best == null ? ms : Math.max(best, ms)
  }
  return clamp(best ?? DEFAULT_PARK_MS)
}

function resetValueMs(value, now) {
  if (!value) return null
  const n = Number(value)
  if (Number.isFinite(n)) {
    if (n > 1e12) return n - now
    if (n > 1e9) return n * 1000 - now
    return n * 1000
  }
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(value)
  if (!m || !m.slice(1).some(Boolean)) return null
  return (
    (Number(m[1]) || 0) * 3_600_000 + (Number(m[2]) || 0) * 60_000 + (Number(m[3]) || 0) * 1000 + (Number(m[4]) || 0)
  )
}
