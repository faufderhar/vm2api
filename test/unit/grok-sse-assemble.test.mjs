import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assembleAnthropicMessageFromSse,
  assembleChatCompletionFromSse,
  grokStreamFailure,
} from '../../src/lib/protocol/grok-sse-assemble.mjs'

test('chat chunks fold into one completion with tool calls', () => {
  const out = assembleChatCompletionFromSse([
    'data: {"id":"c","created":5,"model":"grok-4.3","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"think"}}]}',
    'data: {"id":"c","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get","arguments":"{\\"a\\""}}]}}]}',
    'data: {"id":"c","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ])
  assert.equal(out.id, 'c')
  assert.equal(out.model, 'grok-4.3')
  const message = out.choices[0].message
  assert.equal(message.reasoning_content, 'think')
  assert.equal(message.content, null)
  assert.deepEqual(message.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'get', arguments: '{"a":1}' } }])
  assert.equal(out.choices[0].finish_reason, 'tool_calls')
})

test('anthropic SSE folds into one message', () => {
  const out = assembleAnthropicMessageFromSse([
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"usage":{"input_tokens":2}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  ])
  assert.equal(out.id, 'm')
  assert.equal(out.content[0].text, 'ok')
  assert.equal(out.stop_reason, 'end_turn')
})

test('a stream that failed reports its error', () => {
  assert.equal(
    grokStreamFailure('openai.responses', [
      'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"boom"}}}',
    ]).code,
    'server_error',
  )
  assert.equal(grokStreamFailure('openai.responses', ['data: {"type":"response.completed","response":{}}']), null)
  assert.equal(grokStreamFailure('openai.chat', ['data: {"error":{"message":"bad"}}']).message, 'bad')
})
