import test from 'node:test'
import assert from 'node:assert/strict'
import { detectInboundPlatform } from '../../src/lib/protocol/platform-detect.mjs'
import { isGptSeriesId } from '../../src/lib/protocol/gpt-ids.mjs'
import { resolveInferenceEngine, resolveOfficialCcInference } from '../../src/lib/vm/slot-engine.mjs'

test('detectInboundPlatform maps gpt prefix to openai', () => {
  assert.equal(detectInboundPlatform('gpt-5.4').platform, 'openai')
  assert.equal(detectInboundPlatform('gpt-5.6-sol').platform, 'openai')
  assert.equal(detectInboundPlatform('GPT-5.3-codex').platform, 'openai')
  assert.equal(detectInboundPlatform('claude-sonnet-4-6').platform, 'anthropic')
  assert.equal(detectInboundPlatform('sonnet').platform, 'anthropic')
})

test('claude-opus-4-8 always selects the Anthropic platform', () => {
  assert.deepEqual(detectInboundPlatform('claude-opus-4-8'), {
    ok: true,
    platform: 'anthropic',
    model: 'claude-opus-4-8',
  })
  assert.equal(detectInboundPlatform('openrouter/anthropic/claude-opus-4-8').platform, 'anthropic')
})

test('detectInboundPlatform fail-closes unknown and non-chat gpt', () => {
  assert.equal(detectInboundPlatform('o3').ok, false)
  assert.equal(detectInboundPlatform('codex-auto-review').ok, false)
  assert.equal(detectInboundPlatform('gpt-image-1').ok, false)
  assert.equal(detectInboundPlatform('').ok, false)
})

test('isGptSeriesId is gpt prefix not Claude catalog regex', () => {
  assert.equal(isGptSeriesId('gpt-5.6-sol'), true)
  assert.equal(isGptSeriesId('codex-mini'), false)
  assert.equal(isGptSeriesId('gpt-image-1'), false)
})

test('GPT VM does not inherit rust engine or cli-hop', () => {
  const gpt = { platform: 'openai', family: 'codex' }
  const routing = { inference: { engine: 'rust' }, official_cc: { inference: 'cli-hop' } }
  assert.equal(resolveInferenceEngine(gpt, routing), null)
  assert.equal(resolveOfficialCcInference(gpt, routing), null)
  assert.equal(resolveInferenceEngine({}, routing), 'rust')
})

test('detectInboundPlatform maps grok prefix to xai and rejects generation models', () => {
  assert.deepEqual(detectInboundPlatform('grok-4'), { ok: true, platform: 'xai', model: 'grok-4' })
  assert.equal(detectInboundPlatform('xai/grok-3-mini').platform, 'xai')
  assert.equal(detectInboundPlatform('Grok-Code-Fast-1').platform, 'xai')
  assert.equal(detectInboundPlatform('grok-2-image').ok, false)
  assert.equal(detectInboundPlatform('grok-imagine-video').ok, false)
  assert.equal(detectInboundPlatform('grokky').ok, false)
})
