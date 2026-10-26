/**
 * Reset-first account ordering ("优先使用临近重置的账号").
 *
 * Each provider names one reset clock: Claude and Codex the 7d usage window,
 * Grok the weekly pool reset (credits `currentPeriod.end`, falling back to the
 * reported period end). An account whose clock is in the future
 * and that still has at least MIN_REMAINING of its quota gets a boost: the
 * earlier its reset hour, the sooner it is picked. Everything else (no data,
 * an elapsed reset, under 5% left) keeps the provider's existing order.
 *
 * Bound conversations keep their account while active. Once a session has
 * been idle for `reset_priority_idle_sec` (and has nothing in flight), its
 * next request may re-pick by this order.
 */

import { parseResetMs } from './quota-window.mjs'
import { window7dBucket } from './refresh-order.mjs'

export const RESET_PRIORITY_DEFAULT_ENABLED = true
/**
 * Idle time before a bound session may re-pick, per provider:
 * - Claude 3600 s: the proxy sends Anthropic cache_control ttl 1h by default
 *   (cache-ttl.mjs DEFAULT_CACHE_TTL), so a session quiet for an hour has no
 *   warm prompt cache left to lose.
 * - Codex / Grok 300 s: the session window both slot pools already use
 *   (SessionLimitRegistry idleMin = 5 min) for "this conversation is done".
 */
export const RESET_PRIORITY_IDLE_DEFAULT_SEC = 300
export const CLAUDE_RESET_PRIORITY_IDLE_DEFAULT_SEC = 3600
export const RESET_PRIORITY_IDLE_LIMITS = Object.freeze({ min: 60, max: 86400 })
/** Under this share of quota left an account gets no boost. */
export const RESET_PRIORITY_MIN_REMAINING = 0.05

function hasOwn(obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)
}

export function normalizeResetPriorityIdleSec(value, fallback = RESET_PRIORITY_IDLE_DEFAULT_SEC) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const { min, max } = RESET_PRIORITY_IDLE_LIMITS
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** The two flat fields every provider section carries. */
export function normalizeResetPriorityFields(src = {}, { idleDefaultSec = RESET_PRIORITY_IDLE_DEFAULT_SEC } = {}) {
  const block = src && typeof src === 'object' ? src : {}
  return {
    reset_priority: block.reset_priority == null ? RESET_PRIORITY_DEFAULT_ENABLED : block.reset_priority !== false,
    reset_priority_idle_sec: normalizeResetPriorityIdleSec(block.reset_priority_idle_sec, idleDefaultSec),
  }
}

/** Strict PUT checks. Returns an error message, or null. */
export function resetPriorityPatchError(block, path) {
  if (!block || typeof block !== 'object') return null
  if (hasOwn(block, 'reset_priority') && typeof block.reset_priority !== 'boolean') {
    return `${path}.reset_priority 必须是布尔`
  }
  if (hasOwn(block, 'reset_priority_idle_sec')) {
    const n = block.reset_priority_idle_sec
    const { min, max } = RESET_PRIORITY_IDLE_LIMITS
    if (!Number.isInteger(n) || n < min || n > max) {
      return `${path}.reset_priority_idle_sec 必须是 ${min}–${max} 的整数（秒）`
    }
  }
  return null
}

/** Runtime view of one provider section. */
export function resetPriorityOf(section = {}, opts = {}) {
  const fields = normalizeResetPriorityFields(section, opts)
  return { enabled: fields.reset_priority, idleMs: fields.reset_priority_idle_sec * 1000 }
}

function resetMs(value) {
  const ms = parseResetMs(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The reset time that earns a boost, or null. `remaining` is 0..1 (null =
 * unknown, which does not block the boost). An elapsed reset is stale data,
 * not a promise, so it earns nothing.
 */
export function resetBoostAt(resetAt, remaining = null, now = Date.now()) {
  const ms = resetMs(resetAt)
  if (ms == null || ms <= now) return null
  if (remaining != null && Number.isFinite(Number(remaining)) && Number(remaining) < RESET_PRIORITY_MIN_REMAINING) {
    return null
  }
  return ms
}

/** Hour bucket of a boost time (null when there is none). */
export function resetBoostBucket(value) {
  return value == null ? null : window7dBucket(value)
}

/** Earlier boost hour first; a candidate without a boost sorts after any boosted one. 0 when both lack one. */
export function compareResetBoost(left, right) {
  const l = resetBoostBucket(left)
  const r = resetBoostBucket(right)
  if (l == null && r == null) return 0
  if (l == null) return 1
  if (r == null) return -1
  return l - r
}

/**
 * Keep only the boosted candidates in the earliest boost hour. Without any
 * boosted candidate the list comes back unchanged (existing order applies).
 */
export function earliestResetBand(candidates, boostOf = (candidate) => candidate?.resetBoostAt ?? null) {
  const list = Array.isArray(candidates) ? candidates : []
  let best = null
  for (const candidate of list) {
    const bucket = resetBoostBucket(boostOf(candidate))
    if (bucket != null && (best == null || bucket < best)) best = bucket
  }
  if (best == null) return list
  return list.filter((candidate) => resetBoostBucket(boostOf(candidate)) === best)
}

/**
 * Per-conversation activity: in-flight count and when the last request
 * ended. Idle means nothing in flight and quiet for at least idleMs. With no
 * record (process restart) the sticky row's last bind time stands in.
 */
export class SessionActivity {
  constructor({ maxEntries = 20_000, retainMs = 24 * 60 * 60 * 1000 } = {}) {
    this.entries = new Map()
    this.maxEntries = maxEntries
    this.retainMs = retainMs
  }

  begin(key, now = Date.now()) {
    const id = String(key || '')
    if (!id) return
    const prev = this.entries.get(id)
    this.entries.set(id, { refs: (prev?.refs || 0) + 1, lastSeen: now })
    if (this.entries.size > this.maxEntries) this.prune(now)
  }

  end(key, now = Date.now()) {
    const id = String(key || '')
    if (!id) return
    const prev = this.entries.get(id)
    if (!prev) return
    this.entries.set(id, { refs: Math.max(0, prev.refs - 1), lastSeen: Math.max(prev.lastSeen || 0, now) })
  }

  get(key) {
    return this.entries.get(String(key || '')) || null
  }

  isIdle(key, { idleMs, boundAt = null, now = Date.now() } = {}) {
    const entry = this.get(key)
    if (entry && entry.refs > 0) return false
    const last = entry ? entry.lastSeen : Number(boundAt)
    if (!Number.isFinite(last) || last <= 0) return false
    return now - last >= Math.max(0, Number(idleMs) || 0)
  }

  prune(now = Date.now()) {
    const cutoff = now - this.retainMs
    for (const [key, entry] of this.entries) {
      if (entry.refs === 0 && entry.lastSeen < cutoff) this.entries.delete(key)
    }
    if (this.entries.size <= this.maxEntries) return
    const idle = [...this.entries].filter(([, entry]) => entry.refs === 0).sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    for (const [key] of idle) {
      if (this.entries.size <= this.maxEntries) break
      this.entries.delete(key)
    }
  }

  clear() {
    this.entries.clear()
  }
}

export const sessionActivity = new SessionActivity()

/**
 * A bound conversation that may re-pick by reset order: the feature is on,
 * there is a binding, nothing of this session is in flight and it has been
 * quiet for idleMs.
 */
export function boundSessionIdle(bound, key, { enabled, idleMs, activity = sessionActivity, now = Date.now() } = {}) {
  if (!enabled || !bound || !key) return false
  return activity.isIdle(key, { idleMs, boundAt: bound.boundAt ?? null, now })
}
