import test from 'node:test'
import assert from 'node:assert/strict'
import { anthropicToGrokResponses } from '../../src/lib/protocol/grok-convert.mjs'
import { buildGrokOutbound } from '../../src/lib/protocol/handle-grok.mjs'

const TOOL_LOOP = {
  model: 'grok-4.5',
  system: [{ type: 'text', text: 'Be brief.' }],
  max_tokens: 2048,
  temperature: 0.2,
  top_p: 0.9,
  thinking: { type: 'enabled', budget_tokens: 20000 },
  tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  tool_choice: { type: 'any', disable_parallel_tool_use: true },
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }] },
        { type: 'text', text: 'Summarize.' },
      ],
    },
  ],
}

test('Anthropic convert keeps the tool loop, images, system role and sampling for Grok', () => {
  const out = anthropicToGrokResponses(TOOL_LOOP)
  assert.deepEqual(out.input, [
    { role: 'system', content: 'Be brief.' },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is in this?' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading it.' }] },
    { type: 'function_call', call_id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    { type: 'function_call_output', call_id: 'toolu_1', output: 'hello' },
    { role: 'user', content: 'Summarize.' },
  ])
  assert.equal(out.tools[0].name, 'read_file')
  assert.deepEqual(out.tools[0].parameters.properties.path, { type: 'string' })
  assert.equal(out.tool_choice, 'required')
  assert.equal(out.parallel_tool_calls, false)
  assert.equal(out.max_output_tokens, 2048)
  assert.equal(out.temperature, 0.2)
  assert.equal(out.top_p, 0.9)
  assert.deepEqual(out.reasoning, { effort: 'high' })
  assert.equal(out.stream, true)
  assert.equal(out.store, false)
})

test('Grok convert: effort only for models that take it; errors and named tools map', () => {
  const out = anthropicToGrokResponses({
    model: 'grok-code-fast-1',
    thinking: { type: 'enabled', budget_tokens: 2000 },
    tool_choice: { type: 'tool', name: 'read_file' },
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] }],
  })
  assert.equal(out.reasoning, undefined)
  assert.deepEqual(out.tool_choice, { type: 'function', name: 'read_file' })
  assert.deepEqual(out.input, [{ type: 'function_call_output', call_id: 't', output: 'Error: boom' }])
  assert.deepEqual(anthropicToGrokResponses({ model: 'grok-4.5', output_config: { effort: 'low' }, messages: [] }).reasoning, {
    effort: 'low',
  })
  assert.deepEqual(
    anthropicToGrokResponses({
      model: 'grok-4.20-0309-reasoning',
      thinking: { type: 'enabled', budget_tokens: 8000 },
      messages: [],
    }).reasoning,
    { effort: 'medium' },
  )
  assert.deepEqual(
    anthropicToGrokResponses({
      model: 'openrouter/grok-4.20-multi-agent-0309',
      reasoning_effort: 'high',
      messages: [],
    }).reasoning,
    { effort: 'high' },
  )
})

test('buildGrokOutbound convert mode uses the Grok converter and drops caller identity', () => {
  const out = buildGrokOutbound('anthropic.messages', { ...TOOL_LOOP, metadata: { user_id: 'x' } }, 'convert', { stream: false })
  assert.equal(out.path, '/v1/responses')
  assert.equal(out.convert, true)
  assert.equal(out.clientStream, false)
  assert.equal(out.body.stream, true)
  assert.equal(out.body.metadata, undefined)
  assert.ok(out.body.input.some((item) => item.type === 'function_call_output'))
  assert.equal(out.body.input[0].role, 'system')
})
