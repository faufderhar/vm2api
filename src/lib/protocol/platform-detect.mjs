/**
 * Inbound platform from model id. Unknown models fail closed.
 * GPT = /^gpt/i minus SKIP_GPT. Grok = /^grok/i minus SKIP_GROK. Claude = claude-* family. Not URL, not pin.
 */
import { SKIP_GPT, isGptSeriesId } from './gpt-ids.mjs'
import { SKIP_GROK, isGrokSeriesId } from './grok-ids.mjs'

export function detectInboundPlatform(model) {
  const raw = String(model || '').trim()
  if (!raw) {
    return {
      ok: false,
      code: 'model_required',
      message: 'model is required',
    }
  }
  const id = raw.split('/').filter(Boolean).pop() || raw
  const lower = id.toLowerCase()
  if (SKIP_GPT.test(lower)) {
    return {
      ok: false,
      code: 'model_not_supported',
      message: `model '${raw}' is not a GPT chat model`,
    }
  }
  if (isGptSeriesId(id)) return { ok: true, platform: 'openai', model: id }
  if (SKIP_GROK.test(lower)) {
    return {
      ok: false,
      code: 'model_not_supported',
      message: `model '${raw}' is not a Grok chat model`,
    }
  }
  if (isGrokSeriesId(id)) return { ok: true, platform: 'xai', model: id }
  if (
    lower.startsWith('claude-') ||
    lower.startsWith('anthropic.claude-') ||
    /^(sonnet|opus|haiku|fable)(-|$)/i.test(lower)
  ) {
    return { ok: true, platform: 'anthropic', model: id }
  }
  return {
    ok: false,
    code: 'model_not_supported',
    message: `model '${raw}' is not recognized. No hop.`,
  }
}
