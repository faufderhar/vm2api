import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GROK_CLI_VERSION,
  grokAgentUuid,
  grokCliRequestHeaders,
  grokCliUserAgent,
  grokConvGroupId,
  grokTurnIndex,
  grokPlatformInfo,
  resolveGrokOutboundSession,
} from '../../src/lib/protocol/grok-client.mjs'

test('inference headers identify as the current Grok CLI and carry the outbound session', () => {
  const headers = grokCliRequestHeaders({
    model: 'grok-4.6',
    sessionId: 'sess-1',
    requestId: 'req-1',
    agentId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    turnIdx: 3,
  })
  assert.equal(GROK_CLI_VERSION, '1.0.70')
  assert.equal(headers['user-agent'], grokCliUserAgent())
  assert.match(headers['user-agent'], /^grok-shell\/1\.0\.70 \((macos|windows|linux); .+\)$/)
  assert.equal(headers['x-grok-client-version'], '1.0.70')
  assert.equal(headers['x-grok-client-identifier'], 'grok-shell')
  assert.equal(headers['x-grok-client-mode'], 'headless')
  assert.equal(headers['x-xai-token-auth'], 'xai-grok-cli')
  assert.equal(headers['x-authenticateresponse'], 'authenticate-response')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(headers['x-grok-doom-loop-check'], '1024')
  assert.equal(headers['x-grok-exact-repetition-check'], '64')
  assert.equal(headers['x-grok-turn-idx'], '3')
  assert.equal(headers['x-grok-model-override'], 'grok-4.6')
  assert.equal(headers['x-grok-session-id'], 'sess-1')
  assert.equal(headers['x-grok-conv-id'], 'sess-1')
  assert.equal(headers['x-grok-req-id'], 'req-1')
  assert.equal(headers['x-grok-agent-id'], '0f8fad5b-d9cb-469f-a165-70867728950e')
  assert.equal(
    headers['x-grok-conv-group-id'],
    grokConvGroupId('0f8fad5b-d9cb-469f-a165-70867728950e', 'sess-1'),
  )
  for (const name of ['x-grok-client-surface', 'x-grok-experiments', 'x-userid', 'x-email']) {
    assert.equal(headers[name], undefined, name)
  }
})

test('derived ids are stable v5 UUIDs and match the kernel', () => {
  // Same vectors as grok-kernel/src/headers.rs `derived_ids_are_stable_v5_uuids`.
  const agent = grokAgentUuid('ab'.repeat(32))
  assert.equal(agent, '5910fd6e-751e-5ea7-a95d-73f41dd45224')
  assert.equal(grokConvGroupId(agent, 'sess'), '22307303-fc6d-599c-b9a9-84ee41da6f03')
  assert.equal(grokAgentUuid('0F8FAD5B-D9CB-469F-A165-70867728950E'), '0f8fad5b-d9cb-469f-a165-70867728950e')
  assert.equal(grokAgentUuid(''), '')
})

test('turn index counts user turns and skips tool-result-only user messages', () => {
  assert.equal(grokTurnIndex({}), 1)
  assert.equal(grokTurnIndex({ messages: [{ role: 'user', content: 'hi' }] }), 1)
  assert.equal(
    grokTurnIndex({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'next' },
      ],
    }),
    2,
  )
  assert.equal(
    grokTurnIndex({
      input: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'a' },
        { type: 'function_call_output', call_id: 'c', output: 'x' },
        { type: 'message', role: 'user', content: 'b' },
      ],
    }),
    2,
  )
})

test('empty conversation ids are still sent, matching GrokRequestHeaders::apply', () => {
  const headers = grokCliRequestHeaders({})
  assert.equal(headers['x-grok-conv-id'], '')
  assert.equal(headers['x-grok-req-id'], '')
  assert.equal(headers['x-grok-model-override'], '')
  assert.equal(headers['x-grok-session-id'], '')
  assert.equal(headers['x-grok-agent-id'], '')
  assert.equal(headers['x-grok-turn-idx'], '1')
  assert.deepEqual(grokPlatformInfo('darwin', 'arm64'), { os: 'macos', arch: 'aarch64' })
  assert.equal(grokCliUserAgent('1.0.70', { os: 'linux', arch: 'x86_64' }), 'grok-shell/1.0.70 (linux; x86_64)')
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
