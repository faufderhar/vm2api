/**
 * OpenAI / Codex usage extraction aligned with
 * codex-proxy-rs gateway-protocol `extract_usage`.
 * Does not invent zeros — missing fields stay undefined.
 */

function asU64(value) {
  if (value == null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
    return value
  }
  return undefined
}

function nestedU64(obj, path) {
  let cur = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return asU64(cur)
}

function usageObject(body) {
  if (!body || typeof body !== 'object') return null
  if (body.usage && typeof body.usage === 'object') return body.usage
  return body
}

/**
 * @returns {null | {
 *   input_tokens?: number,
 *   output_tokens?: number,
 *   cached_tokens?: number,
 *   cache_write_tokens?: number,
 *   total_tokens?: number,
 *   reasoning_tokens?: number,
 * }}
 */
export function extractOpenaiUsage(body) {
  const usage = usageObject(body)
  if (!usage || typeof usage !== 'object') return null

  const input_tokens = asU64(usage.input_tokens) ?? asU64(usage.prompt_tokens)
  const output_tokens = asU64(usage.output_tokens) ?? asU64(usage.completion_tokens)
  const cached_tokens =
    nestedU64(usage, ['input_tokens_details', 'cached_tokens']) ??
    nestedU64(usage, ['prompt_tokens_details', 'cached_tokens']) ??
    asU64(usage.cached_tokens)
  const cache_write_tokens =
    nestedU64(usage, ['input_tokens_details', 'cache_write_tokens']) ??
    nestedU64(usage, ['prompt_tokens_details', 'cache_write_tokens']) ??
    asU64(usage.cache_write_tokens) ??
    nestedU64(usage, ['input_tokens_details', 'cache_creation_tokens']) ??
    nestedU64(usage, ['prompt_tokens_details', 'cache_creation_tokens']) ??
    asU64(usage.cache_creation_tokens) ??
    asU64(usage.cache_creation_input_tokens)

  // Subset of output_tokens (OpenAI / xAI); kept for visibility, never billed on top.
  const reasoning_tokens =
    nestedU64(usage, ['output_tokens_details', 'reasoning_tokens']) ??
    nestedU64(usage, ['completion_tokens_details', 'reasoning_tokens']) ??
    asU64(usage.reasoning_tokens)

  const hasUsage =
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usage.prompt_tokens != null ||
    usage.completion_tokens != null ||
    usage.cached_tokens != null ||
    usage.cache_write_tokens != null ||
    usage.input_tokens_details != null ||
    usage.prompt_tokens_details != null ||
    usage.output_tokens_details != null ||
    usage.completion_tokens_details != null ||
    cached_tokens != null ||
    cache_write_tokens != null

  if (!hasUsage) return null

  const total_tokens =
    asU64(usage.total_tokens) ??
    (input_tokens != null || output_tokens != null ? (input_tokens || 0) + (output_tokens || 0) : undefined)

  const out = {}
  if (input_tokens != null) out.input_tokens = input_tokens
  if (output_tokens != null) out.output_tokens = output_tokens
  if (cached_tokens != null) out.cached_tokens = cached_tokens
  if (cache_write_tokens != null) out.cache_write_tokens = cache_write_tokens
  if (total_tokens != null) out.total_tokens = total_tokens
  if (reasoning_tokens != null) out.reasoning_tokens = reasoning_tokens
  return out
}

export function openaiChatUsageFromExtract(extracted) {
  if (!extracted) return null
  if (extracted.input_tokens == null && extracted.output_tokens == null) return null
  const prompt = extracted.input_tokens || 0
  const completion = extracted.output_tokens || 0
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: extracted.total_tokens ?? prompt + completion,
  }
  if (extracted.cached_tokens != null || extracted.cache_write_tokens != null) {
    out.prompt_tokens_details = {}
    if (extracted.cached_tokens != null) out.prompt_tokens_details.cached_tokens = extracted.cached_tokens
    if (extracted.cache_write_tokens != null) {
      out.prompt_tokens_details.cache_creation_tokens = extracted.cache_write_tokens
    }
  }
  return out
}

export function openaiAnthropicUsageFromExtract(extracted) {
  if (!extracted) return { input_tokens: 0, output_tokens: 0 }
  const cached = extracted.cached_tokens || 0
  const written = extracted.cache_write_tokens || 0
  const input = extracted.input_tokens || 0
  const uncached = Math.max(0, input - cached - written)
  const out = {
    input_tokens: uncached,
    output_tokens: extracted.output_tokens || 0,
  }
  if (extracted.cached_tokens != null) out.cache_read_input_tokens = cached
  if (extracted.cache_write_tokens != null) out.cache_creation_input_tokens = written
  return out
}

function hasAnthropicCacheNames(usage) {
  return (
    usage.cache_read_input_tokens != null ||
    usage.cache_creation_input_tokens != null ||
    (usage.cache_creation && typeof usage.cache_creation === 'object')
  )
}

/** OpenAI wire shape: no Anthropic cache names, plus prompt/details/cached aliases. */
export function isOpenaiWireUsage(usage) {
  if (!usage || typeof usage !== 'object') return false
  if (hasAnthropicCacheNames(usage)) return false
  return (
    usage.prompt_tokens != null ||
    usage.input_tokens_details != null ||
    usage.prompt_tokens_details != null ||
    usage.cached_tokens != null ||
    usage.cache_write_tokens != null
  )
}

/**
 * Convert OpenAI-inclusive usage to disjoint Anthropic names exactly once.
 * Already-disjoint objects (Anthropic cache names) are returned unchanged.
 */
export function disjointOpenaiUsage(usage) {
  if (!isOpenaiWireUsage(usage)) return usage
  const extracted = extractOpenaiUsage(usage)
  if (!extracted) return usage
  const converted = openaiAnthropicUsageFromExtract(extracted)
  const out = { ...usage, ...converted }
  delete out.input_tokens_details
  delete out.prompt_tokens_details
  delete out.prompt_tokens
  delete out.completion_tokens
  delete out.cached_tokens
  delete out.cache_write_tokens
  return out
}
