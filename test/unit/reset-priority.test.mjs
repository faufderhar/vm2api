/**
 * reset_priority: accounts whose reset comes soonest go first (Claude / Codex 7d window,
 * Grok Build billing period end); idle sessions may re-pick, active ones never switch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLAUDE_RESET_PRIORITY_IDLE_DEFAULT_SEC,
  RESET_PRIORITY_IDLE_DEFAULT_SEC,
  SessionActivity,
  boundSessionIdle,
  compareResetBoost,
  earliestResetBand,
  normalizeResetPriorityFields,
  resetBoostAt,
  resetPriorityOf,
  resetPriorityPatchError,
} from '../../src/lib/pool/reset-priority.mjs'
import { orderOpenAIAccounts } from '../../src/lib/pool/openai-account-selector.mjs'
import { resetOpenAIAccountRuntime, grokRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { codexAccountCandidate, orderCodexSessionSlots } from '../../src/lib/pool/codex-slot-pool.mjs'
import { grokResetBoostAt, orderGrokSessionSlots } from '../../src/lib/pool/grok-slot-pool.mjs'
import { rankSeatCandidates } from '../../src/lib/pool/seat-planner.mjs'
import { PoolScheduler, normalizePoolRouting } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { normalizeCodexRouting, validateInferenceWebsocketPatch } from '../../src/lib/protocol/codex-route.mjs'
import { normalizeGrokRouting, validateGrokRoutingPatch } from '../../src/lib/protocol/grok-route.mjs'
import { pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { pickGrokCandidates } from '../../src/lib/protocol/handle-grok.mjs'

process.env.VM2API_ALLOW_PRIVATE_PROXY = '1'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

// ── settings ────────────────────────────────────────────────────────────────

test('settings default on, with a per-provider idle default', () => {
  assert.deepEqual(normalizeResetPriorityFields({}), { reset_priority: true, reset_priority_idle_sec: 300 })
  assert.equal(RESET_PRIORITY_IDLE_DEFAULT_SEC, 300)
  const pool = normalizePoolRouting({})
  assert.equal(pool.reset_priority, true)
  assert.equal(pool.reset_priority_idle_sec, CLAUDE_RESET_PRIORITY_IDLE_DEFAULT_SEC)
  assert.equal(CLAUDE_RESET_PRIORITY_IDLE_DEFAULT_SEC, 3600)
  assert.equal(normalizeCodexRouting({}).reset_priority, true)
  assert.equal(normalizeCodexRouting({}).reset_priority_idle_sec, 300)
  assert.equal(normalizeGrokRouting({}).reset_priority, true)
  assert.equal(normalizeGrokRouting({}).reset_priority_idle_sec, 300)
  // Off is kept; junk idle clamps or falls back.
  assert.equal(normalizePoolRouting({ reset_priority: false }).reset_priority, false)
  assert.equal(normalizeCodexRouting({ reset_priority: false, reset_priority_idle_sec: 5 }).reset_priority_idle_sec, 60)
  assert.equal(normalizeGrokRouting({ reset_priority_idle_sec: 'x' }).reset_priority_idle_sec, 300)
  assert.deepEqual(resetPriorityOf({ reset_priority_idle_sec: 120 }), { enabled: true, idleMs: 120_000 })
})

test('strict PUT checks reject a non-boolean toggle or an out-of-range idle', () => {
  assert.equal(resetPriorityPatchError({ reset_priority: true, reset_priority_idle_sec: 600 }, 'codex'), null)
  assert.match(resetPriorityPatchError({ reset_priority: 'yes' }, 'codex'), /reset_priority/)
  assert.match(resetPriorityPatchError({ reset_priority_idle_sec: 30 }, 'grok'), /60–86400/)
  assert.throws(() => validateInferenceWebsocketPatch({ codex: { reset_priority: 1 } }), /codex\.reset_priority/)
  assert.throws(
    () => validateGrokRoutingPatch({ grok: { reset_priority_idle_sec: 1.5 } }),
    /grok\.reset_priority_idle_sec/,
  )
  assert.doesNotThrow(() => validateGrokRoutingPatch({ grok: { reset_priority: false, reset_priority_idle_sec: 900 } }))
})

// ── boost rules ─────────────────────────────────────────────────────────────

test('a boost needs a future reset and at least 5% left', () => {
  const now = Date.parse('2026-10-26T00:00:00.000Z')
  const soon = new Date(now + 2 * HOUR).toISOString()
  assert.equal(resetBoostAt(soon, 0.5, now), now + 2 * HOUR)
  assert.equal(resetBoostAt(soon, null, now), now + 2 * HOUR, 'unknown remaining does not block')
  assert.equal(resetBoostAt(soon, 0.05, now), now + 2 * HOUR, '5% exactly still counts')
  assert.equal(resetBoostAt(soon, 0.049, now), null, 'under 5% left: no boost')
  assert.equal(resetBoostAt(new Date(now - HOUR).toISOString(), 1, now), null, 'elapsed reset is stale data')
  assert.equal(resetBoostAt(null, 1, now), null, 'no data')
  assert.equal(resetBoostAt('not a date', 1, now), null)
  // Unix seconds read like the rest of the pool.
  assert.equal(resetBoostAt(Math.floor((now + HOUR) / 1000), 1, now), now + HOUR)
})

test('boosts compare by hour; no boost sorts last; no boosts leaves the list alone', () => {
  const base = Date.parse('2026-10-26T10:00:00.000Z')
  assert.equal(compareResetBoost(base + 10 * 60_000, base + 50 * 60_000), 0, 'same hour ties')
  assert.ok(compareResetBoost(base, base + HOUR) < 0)
  assert.ok(compareResetBoost(base, null) < 0)
  assert.ok(compareResetBoost(null, base) > 0)
  assert.equal(compareResetBoost(null, null), 0)
  const list = [
    { id: 'a', resetBoostAt: null },
    { id: 'b', resetBoostAt: null },
  ]
  assert.equal(earliestResetBand(list), list)
  const band = earliestResetBand([
    { id: 'late', resetBoostAt: base + 3 * HOUR },
    { id: 'none', resetBoostAt: null },
    { id: 'early-1', resetBoostAt: base + 5 * 60_000 },
    { id: 'early-2', resetBoostAt: base + 40 * 60_000 },
  ])
  assert.deepEqual(
    band.map((c) => c.id),
    ['early-1', 'early-2'],
  )
})

// ── session activity ────────────────────────────────────────────────────────

test('a session is idle only with nothing in flight and quiet for the threshold', () => {
  const activity = new SessionActivity()
  const t0 = 1_000_000
  assert.equal(activity.isIdle('s', { idleMs: 300_000, now: t0 }), false, 'unknown session, no bind time')
  assert.equal(
    activity.isIdle('s', { idleMs: 300_000, boundAt: t0 - 400_000, now: t0 }),
    true,
    'after a restart the last bind time stands in',
  )
  activity.begin('s', t0)
  assert.equal(activity.isIdle('s', { idleMs: 0, now: t0 + DAY }), false, 'in flight is never idle')
  activity.begin('s', t0 + 1)
  activity.end('s', t0 + 10)
  assert.equal(activity.isIdle('s', { idleMs: 0, now: t0 + DAY }), false, 'one request still running')
  activity.end('s', t0 + 20)
  assert.equal(activity.isIdle('s', { idleMs: 300_000, now: t0 + 20 + 299_999 }), false)
  assert.equal(activity.isIdle('s', { idleMs: 300_000, now: t0 + 20 + 300_000 }), true)
  assert.equal(
    boundSessionIdle({ vmId: 'vm' }, 's', { enabled: false, idleMs: 0, activity, now: t0 + DAY }),
    false,
    'toggle off never re-picks',
  )
  assert.equal(boundSessionIdle(null, 's', { enabled: true, idleMs: 0, activity, now: t0 + DAY }), false)
})

test('activity pruning keeps live entries', () => {
  const activity = new SessionActivity({ maxEntries: 2, retainMs: 10 })
  activity.begin('live', 0)
  activity.begin('a', 0)
  activity.end('a', 1)
  activity.begin('b', 5)
  activity.end('b', 6)
  assert.ok(activity.get('live'))
  assert.ok(activity.entries.size <= 2)
})

// ── Codex / Grok selector ───────────────────────────────────────────────────

function account(id, patch = {}) {
  return {
    id,
    weight: 1,
    concurrency: 4,
    status: 'normal',
    inFlight: 0,
    lastStartedAt: null,
    quotaRemainingRank: 10_000,
    failureRateBps: 0,
    firstOutputLatencyMs: null,
    resetBoostAt: null,
    ...patch,
  }
}

test('reset_first: earliest reset hour, then load, then the longest unused, then id', () => {
  const now = Date.parse('2026-10-26T10:00:00.000Z')
  const ordered = orderOpenAIAccounts(
    [
      account('late', { resetBoostAt: now + 3 * DAY, quotaRemainingRank: 10_000 }),
      account('none', { resetBoostAt: null, quotaRemainingRank: 10_000 }),
      account('soon-busy', { resetBoostAt: now + 2 * HOUR + 5 * 60_000, inFlight: 2 }),
      account('soon-used', { resetBoostAt: now + 2 * HOUR + 20 * 60_000, lastStartedAt: now - 1000 }),
      account('soon-fresh', {
        resetBoostAt: now + 2 * HOUR + 40 * 60_000,
        lastStartedAt: null,
        quotaRemainingRank: 600,
      }),
    ],
    { strategy: 'reset_first', maxConcurrent: 4, roundRobinCursor: 0, now },
  )
  assert.deepEqual(ordered.ids, ['soon-fresh', 'soon-used', 'soon-busy', 'late', 'none'])
})

test('reset_first without any reset data is the smart order', () => {
  const list = [
    account('a', { quotaRemainingRank: 2_000 }),
    account('b', { quotaRemainingRank: 9_000 }),
    account('c', { quotaRemainingRank: 5_000 }),
  ]
  const smart = orderOpenAIAccounts(list, { strategy: 'smart', maxConcurrent: 4, roundRobinCursor: 0 })
  const reset = orderOpenAIAccounts(list, { strategy: 'reset_first', maxConcurrent: 4, roundRobinCursor: 0 })
  assert.deepEqual(reset.ids, smart.ids)
})

test('reset_first stays inside the highest weight band', () => {
  const now = Date.now()
  const ordered = orderOpenAIAccounts(
    [
      account('low-soon', { weight: 1, resetBoostAt: now + HOUR }),
      account('high-late', { weight: 5, resetBoostAt: now + 5 * DAY }),
    ],
    { strategy: 'reset_first', maxConcurrent: 4, roundRobinCursor: 0, now },
  )
  assert.equal(ordered.ids[0], 'high-late')
})

function gpt(id, patch = {}) {
  return { id, platform: 'openai', family: 'codex', has_token: true, schedulable: true, status: 'running', ...patch }
}

test('Codex candidate: future 7d reset with ≥5% left is boosted; stale or spent is not', () => {
  const now = Date.parse('2026-10-26T00:00:00.000Z')
  const future = new Date(now + 2 * DAY).toISOString()
  assert.equal(
    codexAccountCandidate(gpt('a', { reset_7d: future, utilization_7d: 0.4 }), now).resetBoostAt,
    now + 2 * DAY,
  )
  assert.equal(codexAccountCandidate(gpt('b', { reset_7d: future, utilization_7d: 0.97 }), now).resetBoostAt, null)
  assert.equal(
    codexAccountCandidate(gpt('c', { reset_7d: new Date(now - HOUR).toISOString() }), now).resetBoostAt,
    null,
  )
  assert.equal(codexAccountCandidate(gpt('d'), now).resetBoostAt, null)
})

test('Codex slots: reset_first puts the soonest 7d reset first; smart keeps the old order', () => {
  resetOpenAIAccountRuntime()
  const now = Date.now()
  const vms = [
    gpt('vm-fresh-late', { utilization_5h: 0, utilization_7d: 0, reset_7d: new Date(now + 6 * DAY).toISOString() }),
    gpt('vm-used-soon', { utilization_5h: 0.3, utilization_7d: 0.6, reset_7d: new Date(now + 3 * HOUR).toISOString() }),
  ]
  const smart = orderCodexSessionSlots(vms, { now, roundRobinCursor: 0 })
  assert.equal(smart.ids[0], 'vm-fresh-late')
  const reset = orderCodexSessionSlots(vms, { now, roundRobinCursor: 0, strategy: 'reset_first' })
  assert.equal(reset.ids[0], 'vm-used-soon')
  // Under 5% left: back to the existing order.
  vms[1].utilization_7d = 0.96
  const spent = orderCodexSessionSlots(vms, { now, roundRobinCursor: 0, strategy: 'reset_first' })
  assert.equal(spent.ids[0], 'vm-fresh-late')
  resetOpenAIAccountRuntime()
})

function grok(id, buildUsage = null) {
  return {
    id,
    platform: 'xai',
    family: 'grok',
    has_token: true,
    status: 'active',
    grok: {},
    grok_build: buildUsage,
  }
}

test('Grok candidate reads the Grok Build billing period end', () => {
  const now = Date.parse('2026-10-26T00:00:00.000Z')
  const end = new Date(now + 5 * DAY).toISOString()
  assert.equal(grokResetBoostAt(grok('a', { period_end: end, credit_usage_percent: 30 }), now), now + 5 * DAY)
  assert.equal(grokResetBoostAt(grok('b', { period_end: end, credit_usage_percent: 96 }), now), null)
  assert.equal(grokResetBoostAt(grok('c', { period_end: new Date(now - DAY).toISOString() }), now), null)
  assert.equal(grokResetBoostAt(grok('d'), now), null)
  // The stored bag works too (getVm shape).
  const raw = { id: 'e', grok: { build_usage: { period_end: end, credit_usage_percent: null } } }
  assert.equal(grokResetBoostAt(raw, now), now + 5 * DAY)
})

test('Grok slots: reset_first follows period_end; smart keeps the old order', () => {
  grokRuntime.reset()
  const now = Date.now()
  const vms = [
    grok('vm-a', { period_end: new Date(now + 20 * DAY).toISOString(), credit_usage_percent: 10 }),
    grok('vm-b', { period_end: new Date(now + 2 * DAY).toISOString(), credit_usage_percent: 50 }),
  ]
  const smart = orderGrokSessionSlots(vms, { now, roundRobinCursor: 0 })
  assert.equal(smart.ids[0], 'vm-a')
  const reset = orderGrokSessionSlots(vms, { now, roundRobinCursor: 0, strategy: 'reset_first' })
  assert.equal(reset.ids[0], 'vm-b')
  grokRuntime.reset()
})

// ── Codex / Grok idle re-pick ───────────────────────────────────────────────

function fakeSticky(bindings) {
  const unbound = []
  return {
    unbound,
    collectPoolKeys: () => ['conv-1'],
    extractPoolKey: () => 'conv-1',
    resolve: (key) => bindings.get(key) || null,
    unbind: (key) => {
      unbound.push(key)
      bindings.delete(key)
    },
  }
}

function writeVm(root, vm) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(path.join(dir, vm.id), { recursive: true })
  fs.writeFileSync(path.join(dir, `${vm.id}.json`), JSON.stringify({ name: vm.id, schedulable: true, ...vm }))
}

function codexProject(now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reset-codex-'))
  for (const [id, reset] of [
    ['vm-home', now + 6 * DAY],
    ['vm-soon', now + 2 * HOUR],
  ]) {
    writeVm(root, { id, platform: 'openai', family: 'codex', status: 'running', has_token: true })
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id }],
      }),
    )
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    vm.codex = {
      usage: { quota: { utilization_5h: 0.1, utilization_7d: 0.2, reset_7d: new Date(reset).toISOString() } },
    }
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  return root
}

test('Codex: an active bound session stays; an idle one re-picks by reset; toggle off keeps it', (t) => {
  resetOpenAIAccountRuntime()
  const now = Date.now()
  const root = codexProject(now)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const req = { headers: {}, apiKeyKind: 'master' }
  const activity = new SessionActivity()
  const bound = () => new Map([['conv-1', { vmId: 'vm-home', accountId: 'vm-home', boundAt: now - 2 * HOUR }]])

  // Active: a request of this conversation is running.
  activity.begin('conv-1', now - HOUR)
  let sticky = fakeSticky(bound())
  let picked = pickCodexCandidates(root, req, { stickyRouter: sticky, body: {}, activity })
  assert.equal(picked.ids[0], 'vm-home')
  assert.deepEqual(sticky.unbound, [])
  activity.end('conv-1', now - 10 * 60_000)

  // Idle for 10 minutes > 5 minute default: re-pick, the soonest reset wins.
  sticky = fakeSticky(bound())
  picked = pickCodexCandidates(root, req, { stickyRouter: sticky, body: {}, activity })
  assert.deepEqual(sticky.unbound, ['conv-1'])
  assert.equal(picked.ids[0], 'vm-soon')

  // A stored response can only continue where it lives.
  sticky = fakeSticky(bound())
  picked = pickCodexCandidates(root, req, {
    stickyRouter: sticky,
    body: { previous_response_id: 'resp_1' },
    activity,
  })
  assert.deepEqual(sticky.unbound, [])
  assert.deepEqual(picked.ids, ['vm-home'])

  // Toggle off: the old behavior (home stays, smart order).
  sticky = fakeSticky(bound())
  picked = pickCodexCandidates(root, req, {
    stickyRouter: sticky,
    body: {},
    activity,
    routing: { codex: { reset_priority: false } },
  })
  assert.deepEqual(sticky.unbound, [])
  assert.equal(picked.ids[0], 'vm-home')
  resetOpenAIAccountRuntime()
})

test('Grok: an idle bound session re-picks by period_end; an active one stays', (t) => {
  grokRuntime.reset()
  const now = Date.now()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reset-grok-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [id, end] of [
    ['vm-home', now + 25 * DAY],
    ['vm-soon', now + 1 * DAY],
  ]) {
    writeVm(root, {
      id,
      platform: 'xai',
      family: 'grok',
      status: 'active',
      has_token: true,
      grok: {
        has_refresh: true,
        build_usage: { ok: true, period_end: new Date(end).toISOString(), credit_usage_percent: 20 },
      },
    })
  }
  const req = { headers: {}, apiKeyKind: 'master' }
  const activity = new SessionActivity()
  const bound = () => new Map([['conv-1', { vmId: 'vm-home', accountId: 'vm-home', boundAt: now - HOUR }]])
  activity.begin('conv-1', now - HOUR)
  let sticky = fakeSticky(bound())
  let picked = pickGrokCandidates(root, req, { stickyRouter: sticky, body: {}, activity })
  assert.equal(picked.ids[0], 'vm-home')
  assert.deepEqual(sticky.unbound, [])
  activity.end('conv-1', now - 6 * 60_000)
  sticky = fakeSticky(bound())
  picked = pickGrokCandidates(root, req, { stickyRouter: sticky, body: {}, activity })
  assert.deepEqual(sticky.unbound, ['conv-1'])
  assert.equal(picked.ids[0], 'vm-soon')
  grokRuntime.reset()
})

// ── Claude ──────────────────────────────────────────────────────────────────

test('seat ranking: a boosted reset hour comes right after priority', () => {
  const openOf = (vmId) => (vmId === 'vm-soon' ? 1 : 0)
  const candidates = [
    { vmId: 'vm-empty', priority: 7, seatCap: 4, headroom: 0.9, resetBoostAt: null },
    { vmId: 'vm-soon', priority: 7, seatCap: 4, headroom: 0.2, resetBoostAt: Date.now() + HOUR },
  ]
  assert.equal(rankSeatCandidates(candidates, { strategy: 'balanced', openOf })[0].vmId, 'vm-soon')
  // Without boosts (toggle off) the existing balanced order wins.
  const off = candidates.map((c) => ({ ...c, resetBoostAt: null }))
  assert.equal(rankSeatCandidates(off, { strategy: 'balanced', openOf })[0].vmId, 'vm-empty')
  // Priority (manual level) still wins.
  const manual = [{ ...candidates[0], priority: 10 }, candidates[1]]
  assert.equal(rankSeatCandidates(manual, { strategy: 'balanced', openOf })[0].vmId, 'vm-empty')
})

function claudeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reset-claude-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  for (const [id, accountId, port] of [
    ['vm-01', 'account-1', 10001],
    ['vm-02', 'account-2', 10002],
  ]) {
    fs.writeFileSync(
      path.join(vms, `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        status: 'running',
        schedulable: true,
        proxy_cli_enabled: true,
        proxy: { id: `proxy-${id}`, url: `socks5h://127.0.0.1:${port}` },
        runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
        policy: { maxConcurrency: 2, concurrencyOverride: true, weight: 1, priority: 0 },
        claude: {
          account_uuid: accountId,
          account_tier: 'max',
          access_token: `access-${accountId}`,
          refresh_token: `refresh-${accountId}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    )
  }
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  return root
}

function claudeScheduler(root, accounts, config = {}) {
  return new PoolScheduler({
    projectRoot: root,
    runtimeRepo: { get: () => null, clearExpired() {}, upsert: (s) => s },
    accountQuota: { repo: { get: (id) => accounts.get(id) || null }, canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5, ...config },
  })
}

function unified(resetAt, utilization) {
  return { headers: { '7d': { reset: resetAt, status: 'allowed', utilization } } }
}

test('Claude: same day, the earlier reset hour wins over more headroom; off keeps headroom order', async (t) => {
  const root = claudeProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const now = Date.now()
  // Both reset within a day (same auto level 7); account-2 has more headroom.
  const accounts = new Map([
    ['account-1', { account_id: 'account-1', unified: unified(now + 2 * HOUR, 0.5) }],
    ['account-2', { account_id: 'account-2', unified: unified(now + 20 * HOUR, 0.1) }],
  ])
  let pool = claudeScheduler(root, accounts)
  let selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.accountId, 'account-1')
  assert.equal(selected.priority, 7)
  selected.release()

  pool = claudeScheduler(root, accounts, { reset_priority: false })
  const off = await pool.eligibleCandidates({ model: 'claude-test' })
  assert.ok(
    off.every((c) => c.resetBoostAt === null),
    'toggle off computes no boost',
  )
  assert.deepEqual(
    off.map((c) => c.priority),
    [7, 7],
    'toggle off keeps the day-level auto priority',
  )
})

test('Claude: under 5% left the soon reset earns nothing; manual priority still wins', async (t) => {
  const root = claudeProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const now = Date.now()
  const accounts = new Map([
    ['account-1', { account_id: 'account-1', unified: unified(now + HOUR, 0.97) }],
    ['account-2', { account_id: 'account-2', unified: unified(now + 5 * DAY, 0.2) }],
  ])
  const pool = claudeScheduler(root, accounts)
  const candidates = await pool.eligibleCandidates({ model: 'claude-test' })
  const byId = new Map(candidates.map((c) => [c.accountId, c]))
  if (byId.has('account-1')) {
    assert.equal(byId.get('account-1').resetBoostAt, null)
    assert.equal(byId.get('account-1').priority, 1)
  }
  assert.ok(byId.get('account-2').resetBoostAt > now)
  const picked = pool.pick(candidates)
  assert.equal(picked.accountId, 'account-2')

  // Missing reset data: no boost, existing order.
  const none = claudeScheduler(root, new Map())
  const plain = await none.eligibleCandidates({ model: 'claude-test' })
  assert.ok(plain.every((c) => c.resetBoostAt === null))

  // Manual level beats the boost.
  const vm1File = path.join(root, 'vms', 'vm-01.json')
  const vm1 = JSON.parse(fs.readFileSync(vm1File, 'utf8'))
  vm1.policy.priority = 10
  fs.writeFileSync(vm1File, JSON.stringify(vm1))
  accounts.set('account-1', { account_id: 'account-1', unified: unified(now + 6 * DAY, 0.2) })
  const manual = await pool.eligibleCandidates({ model: 'claude-test' })
  assert.equal(pool.pick(manual).accountId, 'account-1')
})

function pinRouter(bindings) {
  const unbound = []
  return {
    unbound,
    resolve: (key) => bindings.get(key) || null,
    unbind: (key) => {
      unbound.push(key)
      bindings.delete(key)
    },
  }
}

test('Claude: idle pins release before the request; active, seated, pinned or off do not', (t) => {
  const root = claudeProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const now = Date.now()
  const activity = new SessionActivity()
  const bindings = () =>
    new Map([
      ['sess', { accountId: 'account-1', vmId: 'vm-01', boundAt: now - 2 * HOUR }],
      ['sess-alias', { accountId: 'account-1', vmId: 'vm-01', boundAt: now - 2 * HOUR }],
      ['family', { accountId: 'account-1', vmId: 'vm-01', boundAt: now - 2 * HOUR }],
      ['device', { accountId: 'account-1', vmId: 'vm-01', boundAt: now - 10 * 60_000 }],
    ])
  const make = (router, config = {}) =>
    new PoolScheduler({ projectRoot: root, stickyRouter: router, sessionActivity: activity, config })
  const args = { stickyKey: 'sess', stickyKeys: ['sess', 'sess-alias'], familyKey: 'family', deviceKey: 'device' }

  // Idle 2h > 1h default: session and family go; the device was used 10 minutes ago and stays.
  let router = pinRouter(bindings())
  let released = make(router).releaseIdlePins({ ...args, now })
  assert.deepEqual(released, { session: true, family: true, device: false })
  assert.deepEqual(router.unbound, ['sess', 'sess-alias', 'family'])

  // Active: a request of this session is running.
  activity.begin('sess', now - 3 * HOUR)
  router = pinRouter(bindings())
  released = make(router).releaseIdlePins({ ...args, familyKey: null, deviceKey: null, now })
  assert.equal(released.session, false)
  activity.end('sess', now - 30 * 60_000)
  // Ended 30 min ago: still inside the 1h default; with a 10 min idle it re-picks.
  router = pinRouter(bindings())
  assert.equal(make(router).releaseIdlePins({ ...args, now }).session, false)
  router = pinRouter(bindings())
  assert.equal(make(router, { reset_priority_idle_sec: 600 }).releaseIdlePins({ ...args, now }).session, true)

  // Toggle off, x-kin-vm pin: nothing moves.
  router = pinRouter(bindings())
  assert.deepEqual(make(router, { reset_priority: false }).releaseIdlePins({ ...args, now: now + DAY }), {
    session: false,
    family: false,
    device: false,
  })
  router = pinRouter(bindings())
  assert.equal(make(router).releaseIdlePins({ ...args, pinVmId: 'vm-01', now: now + DAY }).session, false)
  assert.deepEqual(router.unbound, [])
})

test('Claude runner: activity is held for the whole request, so a session never looks idle mid-stream', async () => {
  const activity = new SessionActivity()
  let seenDuring = null
  const runner = new FailoverRunner({ scheduler: { sessionActivity: activity } })
  runner.runOnce = async (args) => {
    seenDuring = activity.isIdle(args.stickyKey, { idleMs: 0, boundAt: 1 })
    return { ok: true }
  }
  await runner.run({ stickyKey: 'sess', stickyKeys: ['sess'], familyKey: 'fam', deviceKey: 'dev' })
  assert.equal(seenDuring, false)
  assert.equal(activity.get('sess').refs, 0)
  assert.equal(activity.get('fam').refs, 0)
  assert.equal(activity.get('dev').refs, 0)
  assert.equal(activity.isIdle('sess', { idleMs: 0 }), true)
})
