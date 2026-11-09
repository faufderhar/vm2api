import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

function harness(t, { acquire, throwOnDelivery = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
  const counts = { acquire: 0, release: 0, hops: 0, off: 0 }
  const response = { headersSent: false, on() {}, once() {}, off: () => (counts.off += 1), end() {} }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'gate', mode: 'normal' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {
      acquire: () => {
        counts.acquire += 1
        return acquire()
      },
      release: () => (counts.release += 1),
      recordUsage() {},
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    failoverRunner: {
      async run() {
        counts.hops += 1
        return { ok: false, status: 503, body: { error: { code: 'none' } } }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1', group_id: 1 },
    once() {},
    off: () => (counts.off += 1),
  }
  if (throwOnDelivery) {
    Object.defineProperty(req.headers, 'x-kin-delivery', {
      get() {
        throw new Error('setup failed')
      },
    })
  }
  return { counts, response, run: () => handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages') }
}

test('a refused key answers with the gate status and leaves no abort listeners', async (t) => {
  const { counts, response, run } = harness(t, {
    acquire: () => ({ ok: false, status: 429, code: 'api_key_concurrency', message: 'busy' }),
  })
  await run()
  assert.equal(response.status, 429, JSON.stringify(response.body))
  assert.equal(counts.hops, 0)
  assert.equal(counts.release, 0)
  assert.equal(counts.off, 2)
})

test('a throw while setting up the request does not strand an inflight count', async (t) => {
  const { counts, run } = harness(t, { acquire: () => ({ ok: true }), throwOnDelivery: true })
  await run().catch(() => {})
  assert.equal(counts.acquire, counts.release)
})

test('an admitted request releases its count once', async (t) => {
  const { counts, run } = harness(t, { acquire: () => ({ ok: true }) })
  await run().catch(() => {})
  assert.equal(counts.hops, 1)
  assert.equal(counts.acquire, 1)
  assert.equal(counts.release, 1)
})
