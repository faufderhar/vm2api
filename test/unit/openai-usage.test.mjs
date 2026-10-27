import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractOpenaiUsage,
  openaiAnthropicUsageFromExtract,
  openaiChatUsageFromExtract,
} from '../../src/lib/protocol/openai-usage.mjs'
import { normalizeUsage } from '../../src/lib/admin/pricing.mjs'

test('extractOpenaiUsage reads input_tokens_details like codex-proxy-rs', () => {
  const usage = extractOpenaiUsage({
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
    },
  })
  assert.deepEqual(usage, {
    input_tokens: 12,
    output_tokens: 5,
    cached_tokens: 3,
    cache_write_tokens: 4,
    total_tokens: 17,
  })
})

test('extractOpenaiUsage reads prompt_tokens_details and top-level cached_tokens', () => {
  assert.equal(
    extractOpenaiUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 80 },
    }).cached_tokens,
    20,
  )
  assert.equal(
    extractOpenaiUsage({
      input_tokens: 8,
      output_tokens: 1,
      cached_tokens: 2,
    }).cached_tokens,
    2,
  )
})

test('extractOpenaiUsage does not invent zeros from empty objects', () => {
  assert.equal(extractOpenaiUsage({}), null)
  assert.equal(extractOpenaiUsage({ foo: 1 }), null)
})

test('Chat usage keeps prompt_tokens_details cache breakdown', () => {
  const chat = openaiChatUsageFromExtract(
    extractOpenaiUsage({
      input_tokens: 41,
      output_tokens: 12,
      input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
    }),
  )
  assert.deepEqual(chat, {
    prompt_tokens: 41,
    completion_tokens: 12,
    total_tokens: 53,
    prompt_tokens_details: { cached_tokens: 8, cache_creation_tokens: 3 },
  })
})

test('Anthropic map uses uncached input plus cache read/write', () => {
  const mapped = openaiAnthropicUsageFromExtract(
    extractOpenaiUsage({
      input_tokens: 100,
      output_tokens: 7,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    }),
  )
  assert.deepEqual(mapped, {
    input_tokens: 70,
    output_tokens: 7,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
  })
})

test('normalizeUsage reads top-level cached_tokens and cache_write_tokens', () => {
  const n = normalizeUsage({
    input_tokens: 100,
    output_tokens: 10,
    cached_tokens: 25,
    cache_write_tokens: 5,
  })
  assert.equal(n.cache_read_tokens, 25)
  assert.equal(n.cache_creation_tokens, 5)
  assert.equal(n.input_tokens, 70)
  assert.equal(n.cache_read_input_tokens, 25)
})

test('extractOpenaiUsage reads reasoning_tokens from Responses and Chat details', () => {
  assert.equal(
    extractOpenaiUsage({
      usage: { input_tokens: 9, output_tokens: 40, output_tokens_details: { reasoning_tokens: 31 } },
    }).reasoning_tokens,
    31,
  )
  assert.equal(
    extractOpenaiUsage({ prompt_tokens: 9, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } })
      .reasoning_tokens,
    12,
  )
  assert.equal(extractOpenaiUsage({ input_tokens: 1, output_tokens: 1 }).reasoning_tokens, undefined)
  // Reasoning is a subset of output: the disjoint billing shape does not add it on top.
  const extracted = extractOpenaiUsage({
    input_tokens: 9,
    output_tokens: 40,
    output_tokens_details: { reasoning_tokens: 31 },
  })
  assert.equal(openaiAnthropicUsageFromExtract(extracted).output_tokens, 40)
})
