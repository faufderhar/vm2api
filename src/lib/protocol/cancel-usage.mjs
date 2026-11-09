/**
 * Output a cancelled stream had already produced when the client left.
 *
 * Anthropic reports output on the final message_delta, Responses and Chat on the last frame.
 * A client that disconnects before those frames has read the tokens without any usage arriving,
 * so the meter counts the generated text and fills the gap with an estimate. UTF-8 bytes / 4 is
 * about right for English and code, and for CJK (3 bytes, roughly 0.75 token a character).
 * Only output is estimated: delivered text is measurable, the cached share of a prompt is not.
 */
const BYTES_PER_TOKEN = 4

export function createCancelOutputMeter() {
  let bytes = 0
  let hintedTokens = 0
  const add = (value) => {
    if (typeof value === 'string') bytes += Buffer.byteLength(value)
  }

  function observe(event) {
    if (!event || typeof event !== 'object') return
    const type = String(event.type || '')
    if (type === 'content_block_delta') {
      const delta = event.delta || {}
      add(delta.text)
      add(delta.thinking)
      add(delta.partial_json)
      add(delta.refusal)
      // Hidden thinking arrives with a count and no text.
      if (!delta.thinking && Number.isFinite(delta.estimated_tokens) && delta.estimated_tokens > 0) {
        hintedTokens += delta.estimated_tokens
      }
      return
    }
    if (type.startsWith('response.') && type.endsWith('.delta')) {
      add(event.delta)
      return
    }
    if (!Array.isArray(event.choices)) return
    for (const choice of event.choices) {
      const delta = choice?.delta
      if (!delta) continue
      add(delta.content)
      add(delta.reasoning_content)
      add(delta.refusal)
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) add(call?.function?.arguments)
    }
  }

  function observeLine(line) {
    if (typeof line !== 'string' || !line.startsWith('data:') || !line.includes('delta')) return
    try {
      observe(JSON.parse(line.slice(5).trim()))
    } catch {}
  }

  /** `usage` with output raised to the estimate; a larger reported figure stands. */
  function fill(usage) {
    const estimated = Math.ceil(bytes / BYTES_PER_TOKEN) + hintedTokens
    if (estimated <= 0) return usage
    const key = usage?.output_tokens == null && usage?.completion_tokens != null ? 'completion_tokens' : 'output_tokens'
    if ((Number(usage?.[key]) || 0) >= estimated) return usage
    return { ...(usage || {}), [key]: estimated }
  }

  return { observe, observeLine, fill }
}
