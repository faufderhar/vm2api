/**
 * The start/stop interval loop shared by the config-driven monitors. `run` is
 * called on every tick (errors swallowed); `getConfig()` is read at each start
 * for `enabled`, `interval_sec` and `run_on_start`.
 */
export function createPeriodicTask(run, getConfig) {
  let timer = null

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const start = ({ immediate = false } = {}) => {
    stop()
    const config = getConfig()
    if (!config.enabled) return { started: false, reason: 'disabled' }
    timer = setInterval(() => {
      run().catch(() => {})
    }, config.interval_sec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    if (immediate && config.run_on_start) {
      queueMicrotask(() => {
        run().catch(() => {})
      })
    }
    return { started: true, interval_sec: config.interval_sec, run_on_start: config.run_on_start }
  }

  return { start, stop }
}
