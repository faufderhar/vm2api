import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  codexResponseStickyKey,
  handleCodexProtocol,
  pickCodexCandidates,
  responseIdFromSseLine,
} from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

// M-1 (DEEP_AUDIT_2026-10-30): a Codex HTTP follow-up that sends only previous_response_id has
// no stable conversation key, so it used to be scheduled on any slot. The producing slot is now
// remembered under resp:<id>, isolated per caller key, like the Grok fix.

beforeEach(() => resetOpenAIAccountRuntime())

function project(t, ids) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-prev-resp-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ids) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({ id, name: id, platform: 'openai', family: 'codex', status: 'running', schedulable: true }),
    )
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id }],
      }),
    )
  }
  return root
}

/** Map-backed router: the conversation key is the input fingerprint, so it changes every turn. */
function fakeSticky() {
  const bindings = new Map()
  const fp = (body) =>
    `ch:${crypto
      .createHash('sha256')
      .update(JSON.stringify(body?.input ?? ''))
      .digest('hex')
      .slice(0, 12)}`
  return {
    bindings,
    isolateKey: (raw, req) => (req?.apiKeyRecord?.id ? `k${req.apiKeyRecord.id}:${raw}` : raw),
    collectPoolKeys: (_req, body) => [fp(body)],
    extractPoolKey: (_req, body) => fp(body),
    resolve: (key) => bindings.get(key) || null,
    bind: (key, payload) => bindings.set(key, payload),
    unbind: (key) => bindings.delete(key),
  }
}

test('response sticky keys are scoped to openai and to the calling key', () => {
  const router = { isolateKey: (raw, req) => (req?.apiKeyRecord?.id ? `k${req.apiKeyRecord.id}:${raw}` : raw) }
  assert.equal(codexResponseStickyKey(router, { apiKeyRecord: { id: 7 } }, 'resp_1'), 'p:openai:k7:resp:resp_1')
  assert.equal(codexResponseStickyKey(null, null, ' resp_2 '), 'p:openai:resp:resp_2')
  assert.equal(codexResponseStickyKey(router, null, ''), null)
  assert.equal(codexResponseStickyKey(router, null, 42), null)
  assert.equal(codexResponseStickyKey(router, null, 'r'.repeat(201)), null)
  assert.equal(
    responseIdFromSseLine('data: {"type":"response.created","response":{"id":"resp_x","output":[]}}'),
    'resp_x',
  )
  assert.equal(responseIdFromSseLine('data: {"type":"other","response":{"id":"resp_x"}}'), null)
})

test('pick: a bound response pins its slot; another key does not see it; a gone slot is 409-able', (t) => {
  const root = project(t, ['vm-a', 'vm-b'])
  const sticky = fakeSticky()
  const req = { headers: {}, apiKeyKind: 'managed', apiKeyRecord: { id: 'key1', group_id: 1, group_type: 'all' } }
  const key = codexResponseStickyKey(sticky, req, 'resp_on_b')
  sticky.bind(key, { accountId: 'vm-b', vmId: 'vm-b' })
  const body = { model: 'gpt-5.4', input: 'brand new turn', previous_response_id: 'resp_on_b' }
  let picked = pickCodexCandidates(root, req, { stickyRouter: sticky, body })
  assert.deepEqual(picked.ids, ['vm-b'])
  assert.equal(picked.sessionKey, key)

  // Another caller key cannot ride this binding.
  const other = { ...req, apiKeyRecord: { id: 'key2', group_id: 1, group_type: 'all' } }
  picked = pickCodexCandidates(root, other, { stickyRouter: sticky, body })
  assert.equal(picked.ids.length, 2)

  // The slot that holds the response left the pool: the request cannot be continued elsewhere.
  fs.rmSync(path.join(root, 'vms', 'vm-b.json'))
  picked = pickCodexCandidates(root, req, { stickyRouter: sticky, body })
  assert.equal(picked.error, 'response_not_portable')
})

test('protocol: every previous_response_id follow-up runs on the slot that produced it', async (t) => {
  const root = project(t, ['vm-a', 'vm-b', 'vm-c'])
  const sticky = fakeSticky()
  const hops = []
  let n = 0
  const send = (input, previous) => {
    const body = { model: 'gpt-5.4', input, stream: false, ...(previous ? { previous_response_id: previous } : {}) }
    let out = null
    return handleCodexProtocol({
      req: { headers: {}, apiKeyKind: 'managed', apiKeyRecord: { id: 'key1', group_id: 1, group_type: 'all' } },
      res: { headersSent: false, write() {}, end() {} },
      protocol: 'openai.responses',
      ctx: { body },
      inbound: { stream: false },
      logBag: {},
      stats: { errors: 0, requests: 0, by_route: {} },
      json: (_res, status, payload) => {
        out = { status, payload }
        return out
      },
      writeSSEHeaders() {},
      routing: {},
      projectRoot: root,
      stickyRouter: sticky,
      ops: {
        writeCodexKernelConfig() {},
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ exec, onEvent }) => {
          n += 1
          hops.push(exec.vmId)
          const id = `resp_${n}_${exec.vmId}`
          await onEvent(
            `data: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output: [] } })}`,
          )
          return { ok: true, status: 200, terminalState: 'verified', body: { id, object: 'response' } }
        },
      },
    }).then(() => out)
  }
  const first = await send('first question')
  assert.equal(first.status, 200)
  const home = hops[0]
  let previous = `resp_1_${home}`
  for (let i = 0; i < 6; i++) {
    const next = await send(`follow-up ${i}`, previous)
    assert.equal(next.status, 200)
    assert.equal(hops.at(-1), home, `turn ${i + 2} stays on ${home}`)
    previous = `resp_${n}_${home}`
  }
})
