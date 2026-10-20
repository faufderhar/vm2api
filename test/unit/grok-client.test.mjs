import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GROK_CLI_VERSION,
  grokCliRequestHeaders,
  grokCliUserAgent,
  grokPlatformInfo,
  resolveGrokOutboundSession,
} from '../../src/lib/protocol/grok-client.mjs'

test('inference headers identify as the current Grok CLI and carry the outbound session', () => {
  const headers = grokCliRequestHeaders({
    model: 'grok-4.6',
    sessionId: 'sess-1',
    requestId: 'req-1',
    agentId: 'agent-1',
  })
  assert.equal(GROK_CLI_VERSION, '1.0.62')
  assert.equal(headers['user-agent'], grokCliUserAgent())
  assert.match(headers['user-agent'], /^grok-shell\/1\.0\.62 \((macos|windows|linux); .+\)$/)
  assert.equal(headers['x-grok-client-version'], '1.0.62')
  assert.equal(headers['x-grok-client-identifier'], 'grok-shell')
  assert.equal(headers['x-grok-model-override'], 'grok-4.6')
  assert.equal(headers['x-grok-session-id'], 'sess-1')
  assert.equal(headers['x-grok-conv-id'], 'sess-1')
  assert.equal(headers['x-grok-req-id'], 'req-1')
  assert.equal(headers['x-grok-agent-id'], 'agent-1')
  for (const name of [
    'x-xai-token-auth',
    'x-authenticateresponse',
    'x-grok-client-mode',
    'x-grok-client-surface',
    'x-grok-experiments',
  ]) {
    assert.equal(headers[name], undefined, name)
  }
})

test('empty conversation ids are still sent, matching GrokRequestHeaders::apply', () => {
  const headers = grokCliRequestHeaders({})
  assert.equal(headers['x-grok-conv-id'], '')
  assert.equal(headers['x-grok-req-id'], '')
  assert.equal(headers['x-grok-model-override'], '')
  assert.equal(headers['x-grok-session-id'], '')
  assert.equal(headers['x-grok-agent-id'], '')
  assert.deepEqual(grokPlatformInfo('darwin', 'arm64'), { os: 'macos', arch: 'aarch64' })
  assert.equal(grokCliUserAgent('1.0.62', { os: 'linux', arch: 'x86_64' }), 'grok-shell/1.0.62 (linux; x86_64)')
})

test('a later turn on the same slot reuses the outbound session already sent upstream', () => {
  const req = { headers: { 'x-session-id': 'client-a', 'user-agent': 'codex_cli_rs/0.133.0' } }
  const body = { messages: [{ role: 'user', content: 'hello' }] }
  const first = resolveGrokOutboundSession({ req, body, vmId: 'heavy', epoch: '1' })
  const second = resolveGrokOutboundSession({
    req,
    body,
    vmId: 'heavy',
    bound: { vmId: 'heavy', sessionId: first.sessionId },
    epoch: '2',
  })
  assert.equal(first.callerSession, 'client-a')
  assert.ok(first.sessionId)
  assert.notEqual(first.sessionId, 'client-a')
  assert.equal(second.sessionId, first.sessionId)
})
