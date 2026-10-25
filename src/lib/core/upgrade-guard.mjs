// Shared guards for HTTP Upgrade (WebSocket) handlers.
//
// An exception thrown inside a server 'upgrade' listener is not caught by
// Node: it lands in process 'uncaughtException' and the raw socket is left
// open forever (no response, no destroy). Every upgrade path must therefore
// answer and destroy the socket on any failure.

const REASONS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
}

/** Write a minimal HTTP response (best effort) and destroy the socket. */
export function rejectUpgradeSocket(socket, status = 400, text) {
  const reason = String(text || REASONS[status] || 'Error')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 120)
  try {
    if (socket && socket.destroyed !== true && socket.writable !== false) {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
  } catch {
    /* peer already gone */
  }
  try {
    socket?.destroy()
  } catch {
    /* ignore */
  }
}

/** decodeURIComponent that returns null instead of throwing URIError. */
export function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value ?? ''))
  } catch {
    return null
  }
}

/**
 * Build one 'upgrade' listener from handlers tried in order. A handler returns
 * true when it took the upgrade. Unclaimed upgrades and any thrown error end
 * with the socket destroyed.
 */
export function guardUpgrade(handlers, { logger = console } = {}) {
  const list = handlers.filter((h) => typeof h === 'function')
  return function onUpgrade(req, socket, head) {
    try {
      for (const handler of list) {
        if (handler(req, socket, head)) return true
      }
      rejectUpgradeSocket(socket, 404)
      return false
    } catch (err) {
      logger?.warn?.(`[upgrade] handler failed: ${err?.name || 'Error'} ${String(err?.message || '').slice(0, 200)}`)
      rejectUpgradeSocket(socket, err instanceof URIError ? 400 : 500)
      return true
    }
  }
}
