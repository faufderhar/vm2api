/**
 * The official Grok client always streams. The gateway does too, and folds the stream
 * back into one JSON body for a caller that asked for `stream: false`.
 */
import { parseSseDataLine } from './stream-keepalive.mjs'
import { assembleCodexBodyFromSse } from './codex-convert.mjs'
import { applyClaudeSSELineToMessage, createClaudeMessageAssembler } from './convert.mjs'

/** Fold `chat.completion.chunk` lines into one `chat.completion`. */
export function assembleChatCompletionFromSse(lines = []) {
  const out = { id: '', object: 'chat.completion', created: 0, model: '', choices: [] }
  const choices = new Map()
  let usage = null
  for (const line of lines) {
    const chunk = parseSseDataLine(line)
    if (!chunk) continue
    if (chunk.id && !out.id) out.id = chunk.id
    if (chunk.created && !out.created) out.created = chunk.created
    if (chunk.model && !out.model) out.model = chunk.model
    if (chunk.system_fingerprint) out.system_fingerprint = chunk.system_fingerprint
    if (chunk.usage) usage = chunk.usage
    for (const part of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const index = Number.isInteger(part?.index) ? part.index : 0
      let choice = choices.get(index)
      if (!choice) {
        choice = { index, message: { role: 'assistant', content: null }, finish_reason: null, tools: new Map() }
        choices.set(index, choice)
      }
      const delta = part.delta || part.message || {}
      if (typeof delta.role === 'string') choice.message.role = delta.role
      if (typeof delta.content === 'string') choice.message.content = (choice.message.content || '') + delta.content
      for (const key of ['reasoning_content', 'refusal']) {
        if (typeof delta[key] === 'string') choice.message[key] = (choice.message[key] || '') + delta[key]
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const slot = Number.isInteger(call?.index) ? call.index : choice.tools.size
        let tool = choice.tools.get(slot)
        if (!tool) {
          tool = { id: '', type: 'function', function: { name: '', arguments: '' } }
          choice.tools.set(slot, tool)
        }
        if (call.id) tool.id = call.id
        if (call.type) tool.type = call.type
        if (call.function?.name) tool.function.name += call.function.name
        if (typeof call.function?.arguments === 'string') tool.function.arguments += call.function.arguments
      }
      if (part.finish_reason) choice.finish_reason = part.finish_reason
      if (part.logprobs) choice.logprobs = part.logprobs
    }
  }
  out.choices = [...choices.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ tools, ...choice }) => {
      if (tools.size) choice.message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t)
      return choice
    })
  if (!out.choices.length) {
    out.choices.push({ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' })
  }
  if (usage) out.usage = usage
  return out
}

/** Fold Anthropic Messages SSE into one message. */
export function assembleAnthropicMessageFromSse(lines = []) {
  const state = createClaudeMessageAssembler()
  for (const line of lines) applyClaudeSSELineToMessage(line, state)
  return state.message || { type: 'message', role: 'assistant', content: [] }
}

/** The non-stream body for `protocol` from the upstream SSE lines. */
export function assembleGrokNonStreamBody(protocol, lines = []) {
  if (protocol === 'openai.chat') return assembleChatCompletionFromSse(lines)
  if (protocol === 'anthropic.messages') return assembleAnthropicMessageFromSse(lines)
  return assembleCodexBodyFromSse(lines, {})
}

/** A stream that ended in `response.failed` or an `error` event: its error, else null. */
export function grokStreamFailure(protocol, lines = []) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const event = parseSseDataLine(lines[i])
    if (!event) continue
    if (event.type === 'response.failed') {
      return event.response?.error || { type: 'api_error', code: 'upstream_failed', message: 'upstream response failed' }
    }
    if (event.type === 'error' || (protocol === 'openai.chat' && event.error && !event.choices)) {
      const error = event.error && typeof event.error === 'object' ? event.error : event
      return {
        type: error.type || 'api_error',
        code: error.code || 'upstream_error',
        message: error.message || 'upstream stream error',
      }
    }
  }
  return null
}
