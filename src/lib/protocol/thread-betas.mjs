const TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 10_000

const pins = new Map()

function sweep(now) {
  for (const [id, pin] of pins) {
    if (pins.size <= MAX_ENTRIES && pin.expiresAt > now) break
    pins.delete(id)
  }
}

export function pinThreadBetas(body, betas, { now = Date.now() } = {}) {
  const thread = body?.thread
  if (!thread || typeof thread !== 'object') return { betas, turn: null }
  const turn = { type: String(thread.type || ''), model: String(body.model || ''), betas }
  if (turn.type !== 'continue') return { betas, turn }
  const from = String(thread.previous_message_id || '')
  const pin = from ? pins.get(from) : null
  if (!pin || pin.expiresAt <= now) return { betas, turn: { ...turn, pin: 'miss', from } }
  if (pin.model !== turn.model) return { betas, turn: { ...turn, pin: 'model_changed', from } }
  const added = pin.betas.filter((token) => !betas.includes(token))
  const extra = betas.filter((token) => !pin.betas.includes(token))
  const pinned = [...pin.betas, ...extra]
  return { betas: pinned, turn: { ...turn, betas: pinned, pin: 'pinned', from, added, extra } }
}

export function rememberThreadTurn(messageId, turn, { now = Date.now() } = {}) {
  const id = String(messageId || '')
  if (!id || !turn) return
  pins.delete(id)
  pins.set(id, { betas: [...turn.betas], model: turn.model, expiresAt: now + TTL_MS })
  sweep(now)
}

export function resetThreadBetasForTest() {
  pins.clear()
}
