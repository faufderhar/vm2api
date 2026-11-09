import test from 'node:test'
import assert from 'node:assert/strict'
import { createCancelOutputMeter } from '../../src/lib/protocol/cancel-usage.mjs'

test('Anthropic text, thinking and tool input all count; input usage is kept', () => {
  const meter = createCancelOutputMeter()
  meter.observe({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'a'.repeat(40) } })
  meter.observe({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'b'.repeat(40) } })
  meter.observe({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'c'.repeat(40) } })
  assert.deepEqual(meter.fill({ input_tokens: 9, output_tokens: 1 }), { input_tokens: 9, output_tokens: 30 })
})

test('hidden thinking is billed from its count', () => {
  const meter = createCancelOutputMeter()
  meter.observe({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } })
  assert.equal(meter.fill(null).output_tokens, 50)
})

test('CJK text is measured in bytes', () => {
  const meter = createCancelOutputMeter()
  meter.observe({ type: 'content_block_delta', delta: { type: 'text_delta', text: '中'.repeat(4) } })
  assert.equal(meter.fill(null).output_tokens, 3)
})

test('Responses stream with no usage yet still produces a bill', () => {
  const meter = createCancelOutputMeter()
  meter.observeLine(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(80) })}`)
  meter.observeLine(
    `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', delta: 'y'.repeat(40) })}`,
  )
  assert.deepEqual(meter.fill(null), { output_tokens: 30 })
})

test('Chat chunks count content and tool arguments under completion_tokens when that is the shape', () => {
  const meter = createCancelOutputMeter()
  meter.observeLine(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: 'x'.repeat(40), tool_calls: [{ function: { arguments: 'y'.repeat(40) } }] } }],
    })}`,
  )
  assert.deepEqual(meter.fill({ prompt_tokens: 5, completion_tokens: 2 }), { prompt_tokens: 5, completion_tokens: 20 })
})

test('a larger reported figure stands and an empty stream leaves usage alone', () => {
  const meter = createCancelOutputMeter()
  const usage = { input_tokens: 3, output_tokens: 99 }
  meter.observe({ type: 'content_block_delta', delta: { text: 'short' } })
  assert.equal(meter.fill(usage), usage)
  assert.equal(createCancelOutputMeter().fill(null), null)
})

test('lines that are not delta events are ignored', () => {
  const meter = createCancelOutputMeter()
  meter.observeLine('event: content_block_delta')
  meter.observeLine('data: [DONE]')
  meter.observeLine('data: {"delta": broken')
  assert.equal(meter.fill(null), null)
})
