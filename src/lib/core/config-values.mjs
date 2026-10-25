/**
 * Lenient config coercion shared by the periodic monitors (notify, health
 * probe, usage probe, credential refresh, kernel watchdog).
 */

/** Booleans from JSON or env-style strings ("1", "yes", "off"…); anything else keeps the fallback. */
export function asBool(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

/** A positive number rounded and clamped to [min, max]; zero, negatives and non-numbers keep the fallback. */
export function clampPositiveInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
