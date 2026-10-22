import { parseResetMs } from './quota-window.mjs'

/** Milliseconds of a 7d window reset, or null when it is missing or invalid. */
export function window7dMs(value) {
  const parsed = parseResetMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Resets inside one hour count as the same reset, so load still spreads across them. */
export const WINDOW_7D_BUCKET_MS = 60 * 60 * 1000

/** Hour bucket of a 7d window reset, or null when it is missing or invalid. */
export function window7dBucket(value) {
  const ms = window7dMs(value)
  return ms == null ? null : Math.floor(ms / WINDOW_7D_BUCKET_MS)
}

/**
 * Earlier 7d window reset first, compared by the hour. A missing time sorts after any real time.
 * Returns 0 when both are missing or in the same hour, so the caller can fall through.
 */
export function compareWindow7dAsc(left, right) {
  const leftMs = window7dBucket(left)
  const rightMs = window7dBucket(right)
  if (leftMs == null && rightMs == null) return 0
  if (leftMs == null) return 1
  if (rightMs == null) return -1
  return leftMs - rightMs
}
