/**
 * Anthropic Messages → Grok `/v1/responses`, shaped like the official grok-shell body.
 *
 * The shared Codex converter is for ChatGPT Codex: it turns `system` into `developer`
 * and drops tool_use, tool_result and images. Grok's own client sends `role: system`
 * with string content, and a multi-turn tool loop needs the calls and their outputs, so
 * the Grok hop uses this converter instead.
 */
import { responsesToolChoice } from './codex-convert.mjs'

/**
 * Models that accept Responses `reasoning.effort` on the Grok convert path.
 * Matches grok-4.5 / 4.6 / 4.7 and grok-4.20+ (reasoning and dated builds).
 * Non-reasoning / code-fast / older lines stay out so we do not send a rejected field.
 */
export function grokModelAcceptsEffort(model) {
  const id = String(model || '')
    .split('/')
    .filter(Boolean)
    .pop()
    .toLowerCase()
  if (!id.startsWith('grok-4.')) return false
  // grok-4.20* (reasoning, non-reasoning, multi-agent, dated builds)
  if (/^grok-4\.20(?:-|$)/.test(id)) return true
  // Classic effort-capable minors: 4.5 / 4.6 / 4.7
  return /^grok-4\.(?:5|6|7)(?:-|$)/.test(id)
}

const EFFORTS = new Set(['low', 'medium', 'high'])

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return typeof content?.text === 'string' ? content.text : ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : ''))
    .filter(Boolean)
    .join('\n')
}

function imageUrl(part) {
  const source = part?.source
  if (source?.type === 'base64' && source.data) {
    return `data:${source.media_type || 'image/png'};base64,${source.data}`
  }
  if (source?.type === 'url' && source.url) return source.url
  if (typeof part?.image_url === 'string') return part.image_url
  if (typeof part?.image_url?.url === 'string') return part.image_url.url
  return ''
}

/** tool_result content → the function_call_output string. Images inside it are dropped. */
function toolResultOutput(part) {
  const text = textOf(part?.content)
  if (part?.is_error === true) return text ? `Error: ${text}` : 'Error'
  return text
}

function userItems(content) {
  if (typeof content === 'string') return content ? [{ role: 'user', content }] : []
  const parts = Array.isArray(content) ? content : []
  const items = []
  const userParts = []
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part) userParts.push({ type: 'input_text', text: part })
      continue
    }
    if (part?.type === 'tool_result') {
      items.push({
        type: 'function_call_output',
        call_id: String(part.tool_use_id || 'call_unknown'),
        output: toolResultOutput(part),
      })
      continue
    }
    if (part?.type === 'image') {
      const url = imageUrl(part)
      if (url) userParts.push({ type: 'input_image', image_url: url })
      continue
    }
    if (part?.type === 'text' && part.text) userParts.push({ type: 'input_text', text: part.text })
  }
  if (userParts.length) {
    // Text-only turns go up as a plain string, like grok-shell.
    const textOnly = userParts.every((part) => part.type === 'input_text')
    items.push({
      role: 'user',
      content: textOnly ? userParts.map((part) => part.text).join('\n') : userParts,
    })
  }
  return items
}

function assistantItems(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] : []
  }
  const items = []
  let text = []
  const flush = () => {
    if (!text.length) return
    items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: text.join('') }] })
    text = []
  }
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === 'text' && part.text) {
      text.push(part.text)
    } else if (part?.type === 'tool_use' && part.name) {
      flush()
      items.push({
        type: 'function_call',
        call_id: String(part.id || `call_${part.name}`),
        name: part.name,
        arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
      })
    }
    // thinking / redacted_thinking: Anthropic signatures mean nothing to xAI. Dropped.
  }
  flush()
  return items
}

function toolsOf(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  const out = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const type = String(tool.type || '')
    if (type.startsWith('web_search')) {
      out.push({ type: 'web_search' })
      continue
    }
    if (!tool.name) continue
    if (type && type !== 'custom' && !tool.input_schema) continue
    out.push({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    })
  }
  return out.length ? out : undefined
}

/** Anthropic thinking / effort → Responses reasoning.effort, only on models that take one. */
function effortOf(body) {
  const asked = String(body?.output_config?.effort || body?.reasoning_effort || '').toLowerCase()
  if (EFFORTS.has(asked)) return asked
  if (asked === 'max' || asked === 'xhigh') return 'high'
  const thinking = body?.thinking
  if (thinking?.type === 'enabled') {
    const budget = Number(thinking.budget_tokens)
    if (!Number.isFinite(budget) || budget <= 0) return 'medium'
    if (budget <= 4096) return 'low'
    if (budget <= 16384) return 'medium'
    return 'high'
  }
  if (thinking?.type === 'adaptive') return 'medium'
  return ''
}

export function anthropicToGrokResponses(body = {}) {
  const input = []
  const system = textOf(body.system)
  if (system) input.push({ role: 'system', content: system })
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'assistant') input.push(...assistantItems(message.content))
    else if (message.role === 'system') {
      const text = textOf(message.content)
      if (text) input.push({ role: 'system', content: text })
    } else input.push(...userItems(message.content))
  }
  const out = { model: body.model, input, store: false, stream: true }
  const tools = toolsOf(body.tools)
  if (tools) out.tools = tools
  const choice = responsesToolChoice(body.tool_choice)
  if (choice) out.tool_choice = choice
  if (body.tool_choice?.disable_parallel_tool_use === true) out.parallel_tool_calls = false
  if (Number.isFinite(Number(body.max_tokens)) && Number(body.max_tokens) > 0) {
    out.max_output_tokens = Number(body.max_tokens)
  }
  for (const key of ['temperature', 'top_p']) {
    if (typeof body[key] === 'number' && Number.isFinite(body[key])) out[key] = body[key]
  }
  const effort = effortOf(body)
  if (effort && grokModelAcceptsEffort(body.model)) out.reasoning = { effort }
  return out
}
