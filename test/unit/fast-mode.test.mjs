import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FAST_MODE_BETA,
  ensureFastModeBeta,
  modelSupportsFastMode,
  sanitizeAnthropicBodyForBetaTokens,
  wantsFastMode,
} from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareOutboundEnvelope } from '../../src/lib/protocol/outbound-attempt.mjs'

const IDENTITY = {
  vmId: 'vm-01',
  deviceId: 'd'.repeat(64),
  accountUuid: '11111111-1111-4111-8111-111111111111',
  timezone: 'America/Los_Angeles',
  userAgent: 'claude-cli/2.1.280 (external, sdk-cli)',
  fingerprint: { locale: 'en_US.UTF-8', timezone: 'America/Los_Angeles' },
}

test('fast mode is Opus 5.5 / Opus 5 / Opus 4.8 only', () => {
  for (const m of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-5[1m]']) {
    assert.equal(modelSupportsFastMode(m), true, m)
  }
  for (const m of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5', 'claude-fable-5']) {
    assert.equal(modelSupportsFastMode(m), false, m)
  }
  assert.equal(wantsFastMode({ model: 'claude-opus-5', speed: 'FAST' }), true)
  assert.equal(wantsFastMode({ model: 'claude-opus-5', speed: 'standard' }), false)
})

test('fast-mode beta is appended once, only when the body asks for fast', () => {
  const body = { model: 'claude-opus-5', speed: 'fast' }
  assert.equal(ensureFastModeBeta('oauth-2025-04-20', body), `oauth-2025-04-20,${FAST_MODE_BETA}`)
  assert.equal(ensureFastModeBeta(`a,${FAST_MODE_BETA}`, body), `a,${FAST_MODE_BETA}`)
  assert.equal(ensureFastModeBeta('a', { model: 'claude-opus-4-7', speed: 'fast' }), 'a')
  assert.equal(ensureFastModeBeta('a', { model: 'claude-opus-5' }), 'a')
})

test('speed is stripped without the beta or on unsupported models', () => {
  const body = { model: 'claude-opus-4-7', speed: 'fast' }
  assert.equal('speed' in sanitizeAnthropicBodyForBetaTokens(body, FAST_MODE_BETA), false)
  assert.equal('speed' in sanitizeAnthropicBodyForBetaTokens({ model: 'claude-opus-5', speed: 'fast' }, ''), false)
  assert.equal(
    sanitizeAnthropicBodyForBetaTokens({ model: 'claude-opus-5', speed: 'fast' }, FAST_MODE_BETA).speed,
    'fast',
  )
})

for (const unofficial of [true, false]) {
  test(`outbound envelope keeps speed + fast-mode beta (${unofficial ? 'mimicry' : 'official'})`, () => {
    const body = { model: 'claude-opus-5', max_tokens: 100, speed: 'fast', messages: [{ role: 'user', content: 'hi' }] }
    const r = prepareOutboundEnvelope({
      identity: IDENTITY,
      canonicalBody: body,
      inbound: body,
      unofficial,
      stream: true,
      reqHeaders: unofficial
        ? {}
        : { 'user-agent': 'claude-cli/2.1.280 (external, cli)', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    assert.equal(r.body.speed, 'fast')
    assert.ok(r.headers['anthropic-beta'].split(',').includes(FAST_MODE_BETA))
  })
}

test('outbound envelope drops speed for a model without fast mode', () => {
  const body = { model: 'claude-opus-4-7', max_tokens: 100, speed: 'fast', messages: [{ role: 'user', content: 'hi' }] }
  const r = prepareOutboundEnvelope({
    identity: IDENTITY,
    canonicalBody: body,
    inbound: body,
    unofficial: true,
    stream: true,
  })
  assert.equal('speed' in r.body, false)
  assert.equal(r.headers['anthropic-beta'].includes(FAST_MODE_BETA), false)
})

test('outbound envelope summarizes a hidden thinking display unless passthrough', () => {
  const body = {
    model: 'claude-opus-5',
    max_tokens: 100,
    thinking: { type: 'adaptive', display: 'omitted' },
    messages: [{ role: 'user', content: 'hi' }],
  }
  const summarized = prepareOutboundEnvelope({
    identity: IDENTITY,
    canonicalBody: body,
    inbound: body,
    unofficial: true,
    stream: true,
  })
  assert.equal(summarized.body.thinking.display, 'summarized')
  const passed = prepareOutboundEnvelope({
    identity: IDENTITY,
    canonicalBody: body,
    inbound: body,
    unofficial: true,
    stream: true,
    routing: { compatibility: { thinking_display: 'passthrough' } },
  })
  assert.equal(passed.body.thinking.display, 'omitted')
})
