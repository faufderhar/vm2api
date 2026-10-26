/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The current time as an ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString()
}
