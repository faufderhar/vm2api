/**
 * Process-local OpenAI-style scheduling signals (Codex and Grok each get their own instance).
 * Failure EWMA matches codex-proxy-rs AccountFeedbackStats:
 * success/failure α=0.2, capacity reject α=0.4, 15 minute half-life.
 */

const FAILURE_ALPHA = 0.2
const CAPACITY_ALPHA = 0.4
const FAILURE_HALF_LIFE_MS = 15 * 60 * 1000
const RPM_WINDOW_MS = 60_000

export const OPENAI_MAX_WAITERS = 100

function decayedFailure(entry, now) {
  if (!entry?.updatedAt) return entry?.value || 0
  const elapsed = Math.max(0, now - entry.updatedAt)
  return entry.value * 0.5 ** (elapsed / FAILURE_HALF_LIFE_MS)
}

function recentStarts(slot, now) {
  if (!slot?.starts?.length) return 0
  slot.starts = slot.starts.filter((t) => now - t < RPM_WINDOW_MS)
  return slot.starts.length
}

/**
 * Waiters are per runtime so a seat freed on one platform never wakes a request queued for another.
 */
export function createAccountRuntime(name = 'openai') {
  const label = String(name || 'openai')
  const slots = new Map()
  const waiters = []
  const feedback = new Map()
  // Upstream failures park an account for a short, process-local window.
  // This is deliberately not the operator switch, which must not be flipped by
  // a transient 401/429/5xx. The hold expires on its own.
  const holds = new Map()
  let roundRobinCursor = 0

  function slotOf(id) {
    const key = String(id || '')
    let slot = slots.get(key)
    if (!slot) {
      slot = { inFlight: 0, lastStartedAt: null, starts: [] }
      slots.set(key, slot)
    }
    return slot
  }

  function signals(id, now = Date.now()) {
    const key = String(id || '')
    const slot = slots.get(key)
    const entry = feedback.get(key)
    const failure = entry ? decayedFailure(entry, now) : 0
    const latency = entry?.latency
    return {
      inFlight: slot?.inFlight || 0,
      lastStartedAt: slot?.lastStartedAt ?? null,
      rpmCount: recentStarts(slot, now),
      rpmResetAt: slot?.starts?.length ? slot.starts[0] + RPM_WINDOW_MS : null,
      failureRateBps: Math.round(Math.min(1, Math.max(0, failure)) * 10_000),
      firstOutputLatencyMs: Number.isFinite(latency) && latency > 0 ? Math.round(latency) : null,
    }
  }

  /** Live failure hold for an account, or null once it has expired. */
  function accountHold(id, now = Date.now()) {
    const key = String(id || '')
    const hold = holds.get(key)
    if (!hold) return null
    if (hold.until <= now) {
      holds.delete(key)
      return null
    }
    return { until: hold.until, reason: hold.reason, set_at: hold.set_at }
  }

  /** Park an account after an uncommitted upstream failure. Longest live hold wins. */
  function holdAccount(id, { until, reason = 'upstream_error', now = Date.now() } = {}) {
    const key = String(id || '')
    const at = Number(until) || 0
    if (!key || !(at > now)) return null
    const current = holds.get(key)
    if (current && current.until >= at) return { ...current }
    const next = { until: at, reason: String(reason || 'upstream_error'), set_at: now }
    holds.set(key, next)
    return { ...next }
  }

  function clearAccountHold(id) {
    holds.delete(String(id || ''))
  }

  function readCursor() {
    return roundRobinCursor
  }

  function bumpCursor() {
    roundRobinCursor += 1
    return roundRobinCursor
  }

  function waiterCount() {
    return waiters.length
  }

  /** FIFO: one released seat wakes the oldest waiter. A woken waiter that still misses passes it on. */
  function wakeWaiter() {
    const next = waiters.shift()
    next?.wake()
  }

  /**
   * One synchronous check-and-claim: concurrency and RPM are read and taken in
   * the same tick, so two admissions can never both see the last free seat.
   * Returns a lease whose release() is idempotent, or null when full.
   */
  function tryAcquire(id, { concurrency = 1, maxRpm = 0, now = Date.now(), quotaPolicy = null } = {}) {
    // Candidate selection resolves pins against the same live policy snapshot.
    // Never replace a resolved legacy/pinned candidate cap with the global cap
    // here: doing so can sell more seats than the candidate was selected for.
    const effectiveConcurrency = Number.isFinite(Number(concurrency))
      ? Number(concurrency)
      : Number(quotaPolicy?.max_concurrency)
    const effectiveRpm = Number.isFinite(Number(maxRpm)) ? Number(maxRpm) : Number(quotaPolicy?.max_rpm)
    const cap = Number(effectiveConcurrency) > 0 ? Number(effectiveConcurrency) : 1
    const slot = slotOf(id)
    if (slot.inFlight >= cap) return null
    const rpm = Number(effectiveRpm) || 0
    if (rpm > 0 && recentStarts(slot, now) >= rpm) return null
    recentStarts(slot, now)
    slot.inFlight += 1
    slot.lastStartedAt = now
    slot.starts.push(now)
    let released = false
    return {
      id: String(id || ''),
      release() {
        if (released) return
        released = true
        slot.inFlight = Math.max(0, slot.inFlight - 1)
        wakeWaiter()
      },
    }
  }

  /**
   * Park until a seat frees, `deadline` passes, or `signal` aborts.
   * Resolves `{ woken }`; throws `pool_wait_queue_full` past OPENAI_MAX_WAITERS.
   */
  function waitForCapacity({ deadline, signal = null } = {}) {
    if (waiters.length >= OPENAI_MAX_WAITERS) {
      return Promise.reject(
        Object.assign(new Error(`${label} pool wait queue is full`), { code: 'pool_wait_queue_full' }),
      )
    }
    return new Promise((resolve) => {
      const entry = {}
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        const at = waiters.indexOf(entry)
        if (at >= 0) waiters.splice(at, 1)
      }
      const onAbort = () => {
        cleanup()
        resolve({ woken: false, aborted: true })
      }
      entry.wake = () => {
        cleanup()
        resolve({ woken: true })
      }
      const timer = setTimeout(
        () => {
          cleanup()
          resolve({ woken: false })
        },
        Math.max(1, Number(deadline) - Date.now()),
      )
      timer.unref?.()
      waiters.push(entry)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  function reportAttempt(id, kind, firstOutputMs = null, now = Date.now()) {
    const key = String(id || '')
    if (!key) return
    if (kind === 'succeeded') holds.delete(key)
    const entry = feedback.get(key) || { value: 0, updatedAt: null, latency: null }
    const sample = kind === 'succeeded' ? 0 : 1
    const alpha = kind === 'capacity_rejected' ? CAPACITY_ALPHA : FAILURE_ALPHA
    const decayed = decayedFailure(entry, now)
    entry.value = alpha * sample + (1 - alpha) * decayed
    entry.updatedAt = now
    const latency = Number(firstOutputMs)
    if (Number.isFinite(latency) && latency > 0) {
      entry.latency = entry.latency == null ? latency : FAILURE_ALPHA * latency + (1 - FAILURE_ALPHA) * entry.latency
    }
    feedback.set(key, entry)
  }

  function reset() {
    slots.clear()
    feedback.clear()
    holds.clear()
    for (const entry of waiters.splice(0)) entry.wake()
    roundRobinCursor = 0
  }

  return Object.freeze({
    name: label,
    signals,
    snapshot: signals,
    accountHold,
    holdAccount,
    clearAccountHold,
    readCursor,
    bumpCursor,
    tryAcquire,
    waiterCount,
    wakeWaiter,
    waitForCapacity,
    reportAttempt,
    reset,
  })
}

export const openaiRuntime = createAccountRuntime('openai')
export const grokRuntime = createAccountRuntime('xai')

export const openAIRuntimeSignals = openaiRuntime.signals
export const openAIRuntimeSnapshot = openaiRuntime.snapshot
export const openAIAccountHold = openaiRuntime.accountHold
export const holdOpenAIAccount = openaiRuntime.holdAccount
export const clearOpenAIAccountHold = openaiRuntime.clearAccountHold
export const readOpenAICursor = openaiRuntime.readCursor
export const bumpOpenAICursor = openaiRuntime.bumpCursor
export const tryAcquireOpenAISlot = openaiRuntime.tryAcquire
export const openAIWaiterCount = openaiRuntime.waiterCount
export const wakeOpenAIWaiter = openaiRuntime.wakeWaiter
export const waitForOpenAICapacity = openaiRuntime.waitForCapacity
export const reportOpenAIAttempt = openaiRuntime.reportAttempt
export const resetOpenAIAccountRuntime = openaiRuntime.reset
