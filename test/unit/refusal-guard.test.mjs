import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { RefusalGuardsRepo } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import { RefusalDeviceBlocksRepo } from '../../src/lib/db/repos/refusal-device-blocks-repo.mjs'
import {
  REFUSAL_GUARD_MESSAGE,
  REFUSAL_GUARD_SETTING,
  isRefusalGuardEnabled,
  isUpstreamRefusal,
  matchStoredRefusal,
  refusalFingerprint,
  refusalGuardError,
} from '../../src/lib/core/refusal-guard.mjs'
import { detectDistill } from '../../src/lib/core/distill-detect.mjs'

function body(user, extra = {}) {
  return {
    model: extra.model || 'claude-opus-5',
    max_tokens: extra.max_tokens || 64,
    stream: extra.stream === true,
    system: extra.system,
    tools: extra.tools,
    messages: [{ role: 'user', content: user }],
  }
}

test('fingerprint ignores stream and max_tokens, includes model', () => {
  const a = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { stream: true, max_tokens: 64 }))
  const b = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { stream: false, max_tokens: 128 }))
  const c = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { model: 'claude-opus-4-8' }))
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('envelope persistable JSON bodies keep distinct fingerprints', () => {
  const a = refusalFingerprint(
    body(
      'thread_id: 01a057ba-d606-7255-a932-a2cfad833afe\n\nPersistable response items (JSON):\n[{"role":"user","text":"再windows 重装 cli"}]',
    ),
  )
  const b = refusalFingerprint(
    body(
      'thread_id: 01a0bb2c-a363-7707-8691-ba523befae35\n\nPersistable response items (JSON):\n[{"role":"user","text":"pull最新源码"}]',
    ),
  )
  assert.notEqual(a, b)
})

test('stop_reason=refusal and Usage Policy API Error are cacheable; distill is not', () => {
  assert.equal(
    isUpstreamRefusal({
      body: {
        error: {
          message:
            'Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)',
        },
      },
    }),
    true,
  )
  assert.equal(
    isUpstreamRefusal(
      { status: 400, terminalState: 'rejected' },
      {
        error_message:
          'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)',
      },
    ),
    true,
  )
  assert.equal(isUpstreamRefusal({ finalState: 'content_filter' }), true)
  assert.equal(isUpstreamRefusal({ body: { stop_reason: 'refusal' } }), true)
  assert.equal(
    isUpstreamRefusal({ body: { content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] } }),
    true,
  )
  assert.equal(isUpstreamRefusal({ body: { error: { code: 'distill_blocked', message: '不允许蒸馏' } } }), false)
})

test('zero inject still allows distill skip while refusal fingerprint is independent', () => {
  const inbound = body('Please reason step by step, and put your final answer within \\boxed{}', {
    max_tokens: 16384,
  })
  const distill = detectDistill({ inbound, body: inbound, zeroInject: true })
  assert.equal(distill.action, 'pass')
  assert.ok(refusalFingerprint(inbound))
})

test('remember then lookup hits the same prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const req = body('Return exactly CACHE_30_5m_OK.')
    const fp = refusalFingerprint(req)
    assert.equal(repo.get(fp), null)
    repo.remember({
      fingerprint: fp,
      model: req.model,
      requestId: 'req-1',
      errorMessage: 'violate our Usage Policy',
      preview: 'Return exactly CACHE_30_5m_OK.',
    })
    const hit = repo.get(fp)
    assert.ok(hit)
    assert.equal(hit.hit_count, 0)
    const bumped = repo.hit(fp)
    assert.equal(bumped.hit_count, 1)
    const other = refusalFingerprint(body('Return exactly CACHE_30_5m_OK.', { model: 'claude-opus-4-8' }))
    assert.equal(repo.get(other), null)
  } finally {
    db.close()
  }
})

test('a permanent refusal replaces the reason of a timed one on the same prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const req = body('Return exactly CACHE_30_5m_OK.')
    const fp = refusalFingerprint(req)
    repo.remember({
      fingerprint: fp,
      model: req.model,
      errorMessage: 'upstream 503',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    repo.remember({ fingerprint: fp, model: req.model, errorMessage: 'violate our Usage Policy' })
    const row = repo.get(fp)
    assert.equal(row.expires_at, null)
    assert.equal(row.error_message, 'violate our Usage Policy')
    // A remember without a reason keeps the stored one.
    repo.remember({ fingerprint: fp, model: req.model })
    assert.equal(repo.get(fp).error_message, 'violate our Usage Policy')
  } finally {
    db.close()
  }
})

test('timed refusal expires and no longer blocks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const req = body('pause this 500')
    const fp = refusalFingerprint(req)
    repo.remember({
      fingerprint: fp,
      model: req.model,
      requestId: 'req-500',
      errorMessage: 'upstream 503',
      preview: 'pause this 500',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    assert.equal(repo.get(fp), null)
    assert.equal(repo.list().length, 0)
  } finally {
    db.close()
  }
})
test('guard error is a non-retryable HTTP 400 request rejection, not a login error', () => {
  const err = refusalGuardError('abc')
  assert.equal(err.status, 400)
  assert.equal(err.body.error.code, 'refusal_guard')
  assert.equal(err.body.error.type, 'policy_blocked')
  assert.equal(err.body.error.message, REFUSAL_GUARD_MESSAGE)
  assert.deepEqual(err.body.error.details, { blocked_by: 'exact', retryable: false })

  const deviceSourceRequestId = '36e239bf-7e70-4a79-80fd-c8a717ff464b'
  const device = refusalGuardError('abc', {
    kind: 'device',
    row: { reason: 'jev:safety', source_request_id: deviceSourceRequestId },
  })
  assert.equal(device.body.error.message, `${REFUSAL_GUARD_MESSAGE} 该设备此前已被封禁（jev:safety）。`)
  assert.deepEqual(device.body.error.details, {
    reason: 'device',
    ban_reason: 'jev:safety',
    blocked_by: 'device',
    retryable: false,
    source_request_id: deviceSourceRequestId,
  })
  const exact = refusalGuardError('abc', { kind: 'exact' })
  assert.equal(exact.body.error.message, `${REFUSAL_GUARD_MESSAGE} 当前提示词与曾被拒答的内容完全一致。`)
  assert.deepEqual(exact.body.error.details, { reason: 'exact', blocked_by: 'exact', retryable: false })
  const similar = refusalGuardError('abc', { kind: 'similar', score: 0.93 })
  assert.equal(similar.body.error.message, `${REFUSAL_GUARD_MESSAGE} 当前提示词与曾被拒答的内容相似（相似度 93%）。`)
  assert.deepEqual(similar.body.error.details, {
    reason: 'similar',
    score: 0.93,
    blocked_by: 'similar',
    retryable: false,
  })
})

test('list remove and clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const a = refusalFingerprint(body('A'))
    const b = refusalFingerprint(body('B'))
    repo.remember({ fingerprint: a, model: 'claude-opus-5', preview: 'A' })
    repo.remember({ fingerprint: b, model: 'claude-opus-5', preview: 'B' })
    assert.equal(repo.count(), 2)
    assert.equal(repo.list().length, 2)
    assert.equal(repo.remove(a), true)
    assert.equal(repo.count(), 1)
    assert.equal(repo.clear(), 1)
    assert.equal(repo.count(), 0)
  } finally {
    db.close()
  }
})

test('refusal fingerprints and device bans do not cross owners', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-owner-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const devices = new RefusalDeviceBlocksRepo(db)
    const inbound = body('tenant only prompt')
    const fp = refusalFingerprint(inbound)
    repo.remember({ fingerprint: fp, model: inbound.model, ownerUserId: 'user-a', preview: 'tenant only prompt' })
    assert.equal(repo.get(fp, 'user-b'), null)
    assert.equal(repo.get(fp), null)
    assert.equal(matchStoredRefusal({ inbound, body: inbound, repo, devices, owner: 'user-b' }), null)
    assert.equal(matchStoredRefusal({ inbound, body: inbound, repo, devices, owner: 'user-a' }).kind, 'exact')
    devices.block({ deviceId: 'client-device-1', ownerUserId: 'user-a', reason: 'refusal_guard' })
    assert.equal(devices.get('client-device-1', 'user-b'), null)
    assert.equal(devices.get('client-device-1'), null)
    assert.ok(devices.get('client-device-1', 'user-a'))
    for (const preview of ['one', 'two', 'three']) {
      repo.remember({ fingerprint: `${fp}:${preview}`, model: inbound.model, ownerUserId: 'user-a', preview })
    }
    assert.equal(repo.prune('user-a', 2), 2)
    assert.equal(repo.countOwner('user-a'), 2)
    assert.equal(repo.countOwner('user-b'), 0)
  } finally {
    db.close()
  }
})

test('nearest does not prune; remember drops expired rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-prune-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const fp = 'c'.repeat(64)
    repo.remember({ fingerprint: fp, model: 'claude-opus-5', ownerUserId: 'user-a', preview: 'stale' })
    db.prepare('UPDATE refusal_guards SET expires_at = ? WHERE fingerprint = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      fp,
    )
    assert.equal(repo.countOwner('user-a'), 1)
    assert.equal(repo.nearest([1], 0.9, 'user-a'), null)
    assert.equal(repo.countOwner('user-a'), 1, 'nearest must not delete rows')
    repo.remember({ fingerprint: 'd'.repeat(64), model: 'claude-opus-5', ownerUserId: 'user-a', preview: 'fresh' })
    assert.equal(repo.get(fp, 'user-a'), null)
    assert.equal(repo.countOwner('user-a'), 1)
  } finally {
    db.close()
  }
})

test('panel delete accepts owner_user_id and otherwise clears every owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-panel-'))
  const project = path.join(dir, 'project')
  fs.mkdirSync(project, { recursive: true })
  const db = openDatabase({ dataDir: dir })
  const fp = 'ab'.repeat(32)
  try {
    const repo = new RefusalGuardsRepo(db)
    const devices = new RefusalDeviceBlocksRepo(db)
    repo.remember({ fingerprint: fp, model: 'm', ownerUserId: 'user-a', preview: 'a' })
    repo.remember({ fingerprint: fp, model: 'm', ownerUserId: 'user-b', preview: 'b' })
    repo.remember({ fingerprint: fp, model: 'm', ownerUserId: '', preview: 'platform' })
    devices.block({ deviceId: 'dev-1', ownerUserId: 'user-a' })
    devices.block({ deviceId: 'dev-1', ownerUserId: 'user-b' })
    const response = {}
    let body = {}
    const handler = createPanelHandler({
      cfg: { paths: { project, root: project }, limits: {} },
      requireAuth(req) {
        req.panelUser = 'admin'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => body,
    })
    const call = async (method, pathname, nextBody, headers = {}) => {
      body = nextBody
      response.status = 0
      response.body = null
      const req = { method, headers, panelUser: 'admin', panelRole: 'admin' }
      await handler(req, {}, new URL(`http://localhost${pathname}`))
      return response
    }
    const one = await call('DELETE', `/api/panel/refusal-guards/${fp}?owner_user_id=user-a`)
    assert.equal(one.status, 200, JSON.stringify(one.body))
    assert.equal(repo.get(fp, 'user-a'), null)
    assert.ok(repo.get(fp, 'user-b'))
    assert.ok(repo.get(fp, ''))
    const all = await call('DELETE', `/api/panel/refusal-guards/${fp}`)
    assert.equal(all.status, 200, JSON.stringify(all.body))
    assert.equal(repo.get(fp, 'user-b'), null)
    assert.equal(repo.get(fp, ''), null)
    const device = await call(
      'DELETE',
      '/api/panel/refusal-device-blocks',
      { device_id: 'dev-1', owner_user_id: 'user-b' },
      { 'content-length': '1' },
    )
    assert.equal(device.status, 200, JSON.stringify(device.body))
    assert.ok(devices.get('dev-1', 'user-a'))
    assert.equal(devices.get('dev-1', 'user-b'), null)
  } finally {
    db.close()
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('panel setting and env can disable the guard', () => {
  const settings = new Map([[REFUSAL_GUARD_SETTING, true]])
  const read = (key, fb) => (settings.has(key) ? settings.get(key) : fb)
  assert.equal(isRefusalGuardEnabled(read), true)
  settings.set(REFUSAL_GUARD_SETTING, false)
  assert.equal(isRefusalGuardEnabled(read), false)
  const prev = process.env.KIN_REFUSAL_GUARD
  process.env.KIN_REFUSAL_GUARD = '0'
  try {
    settings.set(REFUSAL_GUARD_SETTING, true)
    assert.equal(isRefusalGuardEnabled(read), false)
  } finally {
    if (prev == null) delete process.env.KIN_REFUSAL_GUARD
    else process.env.KIN_REFUSAL_GUARD = prev
  }
})

test('a streamed refusal is remembered once with its own reason', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-stream-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {} }))
  const db = createDatabase({ dataDir: root })
  const repo = new RefusalGuardsRepo(db)
  const remembered = []
  const remember = repo.remember.bind(repo)
  let stored = null
  repo.remember = (row) => {
    remembered.push(row.errorMessage)
    stored = row
    return remember(row)
  }
  const inbound = body('Explain how the sticky router picks a VM for a long running session.', { stream: true })
  const response = {
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
    on() {},
    once() {},
    off() {},
    write() {
      return true
    },
    end() {
      response.writableEnded = true
    },
  }
  const handler = createHandleProtocol({
    json: (_res, status, out) => {
      response.status = status
      return out
    },
    writeSSEHeaders(res) {
      res.headersSent = true
    },
    readBody: async () => inbound,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'refusal-stream', mode: 'normal' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    refusalGuards: repo,
    refusalDevices: new RefusalDeviceBlocksRepo(db),
    settings: { get: (_key, fallback) => fallback },
    failoverRunner: {
      async run() {
        // The stream already went out when the upstream refused.
        response.headersSent = true
        return {
          ok: false,
          committed: true,
          finalState: 'content_filter',
          accountId: 'account-1',
          vmId: 'vm-01',
          body: { type: 'message', role: 'assistant', content: [], stop_reason: 'refusal' },
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
    assert.equal(response.writableEnded, true)
    assert.deepEqual(remembered, ['upstream stop_reason=refusal'])
    assert.equal(repo.get(stored.fingerprint, stored.ownerUserId).error_message, 'upstream stop_reason=refusal')
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
