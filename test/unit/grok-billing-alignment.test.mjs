import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { upsertGrokAccount } from '../../src/lib/vm/grok-slot.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { addUsage, hasUsageTokens } from '../../src/lib/protocol/handle-grok.mjs'

// L-2 (DEEP_AUDIT_2026-10-30): Grok billing aligned with the Claude path. A failed request whose
// usage object is all zeros is not charged; usage xAI metered on a hop that failed and was
// switched away from is added to the request's bill instead of being dropped.

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

function harness(t, { slots = ['vm-g1'], kernel, charges = [] }) {
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
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release() {},
      recordUsage: (_rec, usage, opts) => charges.push({ usage, opts }),
    },
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
        return kernel(envelopes.length, vmId, envelope)
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

const ok = (id) => ({
  statusCode: 200,
  headers: {},
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(`${completedSse(id, 'grok-4.7')}\n`)
  },
})
const failed = (status, body) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json' },
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify(body))
  },
})
const body = { model: 'grok-4.7', stream: false, input: 'hi' }

test('addUsage sums nested token counts; hasUsageTokens ignores all-zero objects', () => {
  const sum = addUsage(
    { input_tokens: 5, output_tokens: 1, output_tokens_details: { reasoning_tokens: 1 } },
    { input_tokens: 10, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 } },
  )
  assert.deepEqual(sum, { input_tokens: 15, output_tokens: 41, output_tokens_details: { reasoning_tokens: 31 } })
  assert.equal(addUsage(null, null), null)
  assert.deepEqual(addUsage(null, { input_tokens: 1 }), { input_tokens: 1 })
  assert.equal(hasUsageTokens({ input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }), false)
  assert.equal(hasUsageTokens({ input_tokens: 0, input_tokens_details: { cached_tokens: 2 } }), true)
})

test('a failed Grok request reporting all-zero usage is not charged to the key', async (t) => {
  const charges = []
  const h = harness(t, {
    charges,
    kernel: () =>
      failed(400, {
        error: { code: 'invalid_request', message: 'bad input' },
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
  })
  const { res } = await h.send(body)
  assert.ok(res.status >= 400, `status ${res.status}`)
  assert.equal(charges.length, 0)
})

test('usage metered on a failed attempt is billed together with the attempt that served', async (t) => {
  const charges = []
  const h = harness(t, {
    slots: ['vm-g1', 'vm-g2'],
    charges,
    kernel: (n) =>
      n === 1
        ? failed(503, {
            error: { code: 'server_error', message: 'overloaded' },
            usage: { input_tokens: 7, output_tokens: 3 },
          })
        : ok('resp_ok'),
  })
  const { res, log } = await h.send(body)
  assert.equal(res.status, 200)
  assert.equal(h.envelopes.length, 2)
  assert.equal(log.input_tokens, 17)
  assert.equal(charges.length, 1)
  assert.equal(charges[0].usage.input_tokens, 17)
})

test('usage from a hop that failed over to another slot is billed too', async (t) => {
  const charges = []
  const h = harness(t, {
    slots: ['vm-g1', 'vm-g2'],
    charges,
    kernel: (n) =>
      n === 1
        ? failed(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' }, usage: { input_tokens: 4 } })
        : ok('resp_ok'),
  })
  const { res, log } = await h.send(body)
  assert.equal(res.status, 200)
  assert.equal(h.envelopes.length, 2)
  assert.equal(log.grok_failed_over, true, 'a 429 moves to another slot')
  assert.equal(log.input_tokens, 14)
  assert.equal(charges[0].usage.input_tokens, 14)
})
