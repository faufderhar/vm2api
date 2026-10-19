/**
 * Grok model ids. Chat/reasoning models only; image and video generation have no hop.
 */
export const GROK_ID_PREFIX = /^grok(-|$)/i
export const SKIP_GROK = /^grok-.*(image|imagine|video|vision-gen)/i

export function isGrokSeriesId(id) {
  const value = String(id || '').trim()
  return GROK_ID_PREFIX.test(value) && !SKIP_GROK.test(value)
}
