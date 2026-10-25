/**
 * Process-level fault handling for uncaughtException / unhandledRejection.
 *
 * Default (unchanged behaviour, safest for availability): keep serving and log.
 * Logs are rate limited per kind (a fault in a hot path must not flood the
 * disk) and every fault is counted, with a periodic summary of what was
 * suppressed. VM2API_EXIT_ON_UNCAUGHT=1 makes an uncaught exception run the
 * graceful shutdown with exit code 1, so a supervisor (Docker restart policy,
 * systemd) restarts a process whose state may be inconsistent.
 */
export function createFaultMonitor({
  env = process.env,
  logger = console,
  onFatal = null,
  now = () => Date.now(),
  logsPerWindow = 5,
  windowMs = 60_000,
} = {}) {
  const exitOnUncaught = String(env.VM2API_EXIT_ON_UNCAUGHT || '').trim() === '1'
  const counts = { uncaughtException: 0, unhandledRejection: 0 }
  const windows = new Map()
  let fatal = false

  function shouldLog(kind) {
    const t = now()
    let w = windows.get(kind)
    if (!w || t - w.start >= windowMs) {
      if (w?.suppressed) logger.error?.(`[${kind}] ${w.suppressed} more suppressed in the last ${Math.round(windowMs / 1000)}s`)
      w = { start: t, logged: 0, suppressed: 0 }
      windows.set(kind, w)
    }
    if (w.logged < logsPerWindow) {
      w.logged += 1
      return true
    }
    w.suppressed += 1
    return false
  }

  function record(kind, error) {
    counts[kind] += 1
    const tag = kind === 'uncaughtException' ? '[uncaught]' : '[unhandled]'
    if (shouldLog(kind)) logger.error?.(tag, error)
    if (kind === 'uncaughtException' && exitOnUncaught && !fatal) {
      fatal = true
      logger.error?.('[uncaught] VM2API_EXIT_ON_UNCAUGHT=1: shutting down for a supervised restart')
      onFatal?.(error)
    }
  }

  return {
    counts,
    exitOnUncaught,
    onUncaughtException: (e) => record('uncaughtException', e),
    onUnhandledRejection: (e) => record('unhandledRejection', e),
    install(proc = process) {
      proc.on('uncaughtException', this.onUncaughtException)
      proc.on('unhandledRejection', this.onUnhandledRejection)
      return this
    },
  }
}
