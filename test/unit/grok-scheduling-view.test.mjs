import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { effectiveGrokPolicy } from '../../src/lib/pool/openai-quota-policy.mjs'
import { summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import { enrichVm } from '../../src/lib/admin/panel-api.mjs'
import { grokAccountCandidate, grokMaxSessions } from '../../src/lib/pool/grok-slot-pool.mjs'

const routing = {
  grok: { quota: { max_concurrency: 7, max_rpm: 30, max_sessions: 3 } },
  // Claude tiers must never leak into a Grok slot's view.
  tiers: { default: { max_concurrency: 20, max_rpm: 0 } },
  concurrency: { default_max_per_account: 20 },
}

function grokVm(policy) {
  return { id: 'grok-a', status: 'running', platform: 'xai', family: 'grok', kind: 'grok', grok: {}, policy }
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sched-'))
}

test('a Grok knob is pinned only by an explicit override flag', () => {
  const global = routing.grok.quota
  // Stale snapshot (old default 2) with the flag false or missing follows global.
  assert.deepEqual(effectiveGrokPolicy(grokVm({ maxConcurrency: 2, concurrencyOverride: false }), global), {
    max_concurrency: 7,
    max_rpm: 30,
    max_sessions: 3,
    concurrency_override: false,
    rpm_override: false,
    sessions_override: false,
  })
  const legacy = effectiveGrokPolicy(grokVm({ maxConcurrency: 2, maxRpm: 0, maxSessions: 0 }), global)
  assert.equal(legacy.max_concurrency, 7)
  assert.equal(legacy.concurrency_override, false)
  assert.equal(legacy.max_sessions, 3)
  const pinned = effectiveGrokPolicy(
    grokVm({ maxConcurrency: 4, concurrencyOverride: true, maxSessions: 1, sessionsOverride: true }),
    global,
  )
  assert.equal(pinned.max_concurrency, 4)
  assert.equal(pinned.concurrency_override, true)
  assert.equal(pinned.max_sessions, 1)
  assert.equal(pinned.sessions_override, true)
  assert.equal(pinned.max_rpm, 30)
})

test('the Grok slot summary reports the enforced caps and the Grok global fallback', () => {
  const root = tmpProject()
  try {
    const row = summarizeVm(grokVm({ maxConcurrency: 2, concurrencyOverride: false, maxSessions: 0 }), root, routing)
    assert.equal(row.max_concurrency, 7)
    assert.equal(row.max_concurrency_override, false)
    assert.equal(row.max_sessions, 3)
    assert.deepEqual(row.scheduling_inherited, {
      max_concurrency: 7,
      max_rpm: 30,
      max_sessions: 3,
      session_slots: null,
    })
    const pinned = summarizeVm(
      grokVm({ maxConcurrency: 5, concurrencyOverride: true, maxSessions: 1, sessionsOverride: true }),
      root,
      routing,
    )
    assert.equal(pinned.max_concurrency, 5)
    assert.equal(pinned.max_concurrency_override, true)
    // The scheduler reads the same summary, so the per-slot session pin is enforced.
    assert.equal(grokAccountCandidate(pinned, Date.now(), {}, routing.grok.quota).concurrency, 5)
    assert.equal(grokMaxSessions(pinned, routing.grok.quota), 1)
    assert.equal(grokAccountCandidate(row, Date.now(), {}, routing.grok.quota).concurrency, 7)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the scheduling editor inherits Grok global, not the Claude default tier', () => {
  const root = tmpProject()
  try {
    const listed = summarizeVm(grokVm({ maxConcurrency: 2, concurrencyOverride: false }), root, routing)
    const row = enrichVm(listed, null, null, { routingConfig: routing })
    assert.equal(row.max_concurrency, 7)
    assert.equal(row.concurrency_override, false)
    assert.equal(row.max_rpm, 30)
    assert.equal(row.max_sessions, 3)
    assert.equal(row.max_sessions_override, false)
    assert.equal(row.session_slots, null)
    assert.equal(row.scheduling_inherited.max_concurrency, 7)
    assert.equal(row.scheduling_inherited.max_rpm, 30)
    assert.equal(row.scheduling_inherited.max_sessions, 3)
    assert.equal(row.scheduling_inherited.session_slots, null)

    const pinned = enrichVm(
      summarizeVm(grokVm({ maxConcurrency: 4, concurrencyOverride: true }), root, routing),
      null,
      null,
      { routingConfig: routing },
    )
    assert.equal(pinned.max_concurrency, 4)
    assert.equal(pinned.concurrency_override, true)
    assert.equal(pinned.scheduling_inherited.max_concurrency, 7)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
