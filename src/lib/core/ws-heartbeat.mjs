/**
 * Ping a WebSocket and terminate it after one missed pong. A half-open peer
 * (laptop lid closed, NAT dropped) never sends close, so without this the
 * shell session, its exec/SSH channel and its session slot leak until restart.
 * terminate() emits 'close', so the caller's normal close cleanup runs.
 */
export const DEFAULT_WS_HEARTBEAT_MS = 30_000

export function wsHeartbeatMs(env = process.env, fallback = DEFAULT_WS_HEARTBEAT_MS) {
  const raw = String(env.VM2API_WS_HEARTBEAT_MS ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n === 0 ? 0 : Math.max(1000, Math.floor(n))
}

/** @returns {() => void} stop */
export function startWsHeartbeat(ws, intervalMs = wsHeartbeatMs()) {
  if (!ws || !(intervalMs > 0)) return () => {}
  let alive = true
  const onPong = () => {
    alive = true
  }
  ws.on('pong', onPong)
  const timer = setInterval(() => {
    if (!alive) {
      stop()
      try {
        ws.terminate()
      } catch {}
      return
    }
    alive = false
    try {
      ws.ping()
    } catch {}
  }, intervalMs)
  timer.unref?.()
  let stopped = false
  function stop() {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    ws.off?.('pong', onPong)
  }
  ws.once?.('close', stop)
  return stop
}
