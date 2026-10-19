import { parseResetMs } from './quota-window.mjs'

/** Milliseconds of a 7d window reset, or null when it is missing or invalid. */
export function window7dMs(value) {
  const parsed = parseResetMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Earlier 7d window reset first. A missing time sorts after any real time.
 * Returns 0 when both are missing or equal, so the caller can fall through.
 */
export function compareWindow7dAsc(left, right) {
  const leftMs = window7dMs(left)
  const rightMs = window7dMs(right)
  if (leftMs == null && rightMs == null) return 0
  if (leftMs == null) return 1
  if (rightMs == null) return -1
  return leftMs - rightMs
}
