import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clientCancelledResult } from '../../src/lib/core/errors.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

test('clientCancelledResult keeps usage that lived only on the assembled message', () => {
  const result = clientCancelledResult({
    committed: true,
    via: 'go-worker-stream',
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      usage: { input_tokens: 9, output_tokens: 2 },
    },
  })
  assert.equal(result.body.error.code, 'client_cancelled')
  assert.equal(result.terminalState, 'cancelled')
  assert.equal(result.usage.input_tokens, 9)
  assert.equal(result.usage.output_tokens, 2)
  assert.equal(result.committed, true)
})

test('a cancelled Claude hop bills produced usage and ingests account quota', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cancel-bill-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
  const usage = { input_tokens: 12, output_tokens: 4 }
  const ingested = []
  const charges = []
  const response = {
    headersSent: false,
    on(event, fn) {
      if (event === 'finish') response.finish = fn
    },
    once() {},
    off() {},
    end() {},
  }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'cancel-bill', mode: 'normal' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: {
      ingestHeaders(accountId, headers, usageBody, extra) {
        ingested.push({ accountId, headers, usageBody, extra })
      },
    },
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release() {},
      recordUsage: (_key, billed, opts) => charges.push({ billed, opts }),
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    failoverRunner: {
      async run() {
        return clientCancelledResult({
          accountId: 'account-1',
          vmId: 'vm-01',
          committed: true,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.4' },
          body: { type: 'message', role: 'assistant', content: [], usage },
        })
      },
    },
    groupsRepo: { rateMultiplier: () => 2 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1', group_id: 1 },
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(ingested.length, 1)
    assert.equal(ingested[0].accountId, 'account-1')
    assert.equal(ingested[0].usageBody.input_tokens, 12)
    assert.equal(ingested[0].usageBody.output_tokens, 4)
    assert.equal(charges.length, 1)
    assert.equal(charges[0].billed.input_tokens, 12)
    assert.equal(charges[0].billed.output_tokens, 4)
    assert.equal(charges[0].opts.rateMultiplier, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a failed Claude hop with no usage does not spend request quota', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fail-bill-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
  const charges = []
  let hops = 0
  const response = {
    headersSent: false,
    on() {},
    once() {},
    off() {},
    end() {},
  }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'fail-bill', mode: 'normal' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release() {},
      recordUsage: () => charges.push('billed'),
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    failoverRunner: {
      async run() {
        hops++
        return {
          ok: false,
          status: 529,
          accountId: 'account-1',
          vmId: 'vm-01',
          body: { error: { type: 'overloaded_error', code: 'pool_exhausted', message: 'pool exhausted' } },
          headers: {},
        }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'test-client' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1', group_id: 1 },
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    // The hop ran and its failure reached the client; only then is "no charge" meaningful.
    assert.equal(hops, 1)
    assert.equal(response.status, 529)
    assert.equal(charges.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
