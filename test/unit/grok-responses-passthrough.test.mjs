import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { upsertGrokAccount } from '../../src/lib/vm/grok-slot.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { GROK_CLI_VERSION } from '../../src/lib/protocol/grok-client.mjs'

// A Responses request for grok-4.7 at xhigh goes through the whole gateway (auth, sanitize,
// intercept, platform routing, slot pick, kernel envelope) and reaches the kernel unchanged.

function writeSlot(root, id) {
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'xai',
      family: 'grok',
      status: 'running',
      proxy: { id: 'px-local', scheme: 'local' },
      grok: {},
    }),
  )
  upsertGrokAccount(root, id, { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3_600_000 })
}

function completedSse(id, model) {
  return [
    'event: response.created',
    `data: {"type":"response.created","sequence_number":0,"response":{"id":"${id}","object":"response","status":"in_progress","model":"${model}","output":[]}}`,
    '',
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","sequence_number":1,"output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc-1"}}',
    '',
    'event: response.completed',
    `data: {"type":"response.completed","sequence_number":2,"response":{"id":"${id}","object":"response","status":"completed","model":"${model}","output":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc-1"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":10,"output_tokens":40,"output_tokens_details":{"reasoning_tokens":30}}}}`,
    '',
  ].join('\n')
}

function harness(t, { slots = ['vm-g1'], kernel }) {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-resp-pass-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of slots) writeSlot(root, id)
  const routing = {
    grok: { enabled: true, protocols: { 'openai.responses': { enabled: true, mode: 'native' } } },
    pool: { fallback_wait_timeout_ms: 2000 },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const stickyRouter = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  const logs = []
  let pendingBody = null
  const envelopes = []
  const handler = createHandleProtocol({
    json: (res, status, payload) => {
      res.status = status
      res.payload = payload
    },
    writeSSEHeaders(res) {
      res.headersSent = true
    },
    readBody: async () => pendingBody,
    requireAuth: (req) => {
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = { id: 'key-1', group_id: 1, group_type: 'all' }
      return true
    },
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000, stream_idle_timeout_ms: 5000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: `rq-${logs.length}`, mode: 'normal', capture_outbound: true }),
      finish: (_ctx, extra) => logs.push(extra),
    },
    stickyRouter,
    accountQuota: { sessions: null, ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    grokOps: {
      writeGrokKernelConfig: (_root, vm) => ({ agentId: 'ab'.repeat(32), vmId: vm?.id }),
      callGrokKernel: async ({ vmId, envelope }) => {
        envelopes.push({ vmId, envelope })
        const { id, model } = kernel(envelopes.length, vmId, envelope)
        return {
          statusCode: 200,
          headers: {},
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(completedSse(id, model) + '\n')
          },
        }
      },
    },
  })
  const send = async (body, headers = {}) => {
    pendingBody = body
    const finished = []
    const res = {
      headersSent: false,
      on: (event, fn) => event === 'finish' && finished.push(fn),
      once() {},
      off() {},
      setHeader() {},
      write() {},
      end() {},
    }
    const req = {
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: 'Bearer sk-test', 'user-agent': 'OpenAI/JS 6.0.0', ...headers },
      once() {},
      off() {},
    }
    await handler.handleProtocol(req, res, 'openai.responses', '/v1/responses')
    for (const fn of finished) fn()
    return { res, log: logs.at(-1) }
  }
  return { send, envelopes, logs, stickyRouter }
}

test('responses grok-4.7 xhigh: the kernel gets the caller body verbatim, only identity keys gone', async (t) => {
  const h = harness(t, { kernel: () => ({ id: 'resp_a', model: 'grok-4.7' }) })
  const inbound = {
    model: 'grok-4.7',
    stream: false,
    instructions: 'be precise',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'prove it' }] }],
    reasoning: { effort: 'xhigh', summary: 'concise' },
    include: ['reasoning.encrypted_content'],
    store: false,
    previous_response_id: 'resp_unknown_to_gateway',
    max_output_tokens: 64000,
    temperature: 0.3,
    top_p: 0.9,
    text: { verbosity: 'high' },
    tool_choice: 'auto',
    parallel_tool_calls: true,
    tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} } }],
    user: 'tenant@example.com',
    safety_identifier: 'sid',
    prompt_cache_key: 'caller-key',
    metadata: { team: 'example' },
  }
  const { res, log } = await h.send(structuredClone(inbound))
  assert.equal(res.status, 200)
  assert.equal(h.envelopes.length, 1)
  const { envelope } = h.envelopes[0]
  const sent = envelope.body
  const expected = { ...inbound, stream: true, prompt_cache_key: envelope.session_id }
  for (const key of ['user', 'safety_identifier', 'metadata']) delete expected[key]
  assert.deepEqual(sent, expected)
  assert.deepEqual(sent.reasoning, { effort: 'xhigh', summary: 'concise' })
  assert.equal(envelope.model_id, 'grok-4.7')
  assert.equal(envelope.path, '/v1/responses')
  // Headers the official client sends on its main call (the kernel adds auth and accept).
  const outHeaders = log.outbound_headers
  assert.equal(outHeaders['x-grok-model-override'], 'grok-4.7')
  assert.equal(outHeaders['x-grok-client-mode'], 'headless')
  assert.equal(outHeaders['x-grok-doom-loop-check'], '1024')
  assert.equal(outHeaders['x-grok-exact-repetition-check'], '64')
  assert.equal(outHeaders['x-grok-conv-id'], envelope.session_id)
  assert.equal(outHeaders['x-grok-client-version'], GROK_CLI_VERSION)
  assert.equal(log.reasoning_effort, 'xhigh')
  assert.equal(log.upstream_model, 'grok-4.7')
  assert.equal(log.reasoning_tokens, 30)
  assert.equal(log.outbound_session_id, envelope.session_id)
  // The non-stream fold keeps the encrypted reasoning item for the caller to replay.
  assert.equal(res.payload.output[0].type, 'reasoning')
  assert.equal(res.payload.output[0].encrypted_content, 'enc-1')
})

test('a previous_response_id follow-up runs on the slot that produced that response', async (t) => {
  // Two slots; the first turn lands somewhere, the follow-up sends only new input + previous id.
  const h = harness(t, {
    slots: ['vm-g1', 'vm-g2'],
    kernel: (n, vmId) => ({ id: `resp_${n}_${vmId}`, model: 'grok-4.7' }),
  })
  const turn = (input, previous) => ({
    model: 'grok-4.7',
    stream: false,
    reasoning: { effort: 'xhigh' },
    input,
    ...(previous ? { previous_response_id: previous } : {}),
  })
  const first = await h.send(turn('first question'))
  assert.equal(first.res.status, 200)
  const home = h.envelopes[0].vmId
  let previous = first.res.payload.id
  assert.equal(previous, `resp_1_${home}`)
  for (let i = 0; i < 6; i++) {
    const next = await h.send(turn(`follow-up ${i} ${'x'.repeat(i)}`, previous))
    assert.equal(next.res.status, 200)
    const hop = h.envelopes.at(-1)
    assert.equal(hop.vmId, home, `turn ${i + 2} stays on the slot holding ${previous}`)
    assert.equal(hop.envelope.body.previous_response_id, previous)
    assert.equal(hop.envelope.body.reasoning.effort, 'xhigh')
    // Same outbound conversation id, so xAI sees one conversation and keeps its prompt cache.
    assert.equal(hop.envelope.session_id, h.envelopes[0].envelope.session_id)
    previous = next.res.payload.id
  }
})

test('response sticky keys are scoped to xai and to the calling key', async () => {
  const { grokResponseStickyKey } = await import('../../src/lib/protocol/handle-grok.mjs')
  const router = { isolateKey: (raw, req) => (req?.apiKeyRecord?.id ? `k${req.apiKeyRecord.id}:${raw}` : raw) }
  assert.equal(grokResponseStickyKey(router, { apiKeyRecord: { id: 7 } }, 'resp_1'), 'p:xai:k7:resp:resp_1')
  assert.equal(grokResponseStickyKey(null, null, ' resp_2 '), 'p:xai:resp:resp_2')
  assert.equal(grokResponseStickyKey(router, null, ''), null)
  assert.equal(grokResponseStickyKey(router, null, 42), null)
  assert.equal(grokResponseStickyKey(router, null, 'r'.repeat(201)), null)
})
