import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUsageProbeMonitor, normalizeUsageProbeConfig } from '../../src/lib/oauth/usage-probe-monitor.mjs'

// Fixtures bind slots to a 127.0.0.1 SOCKS, which production blocks by default.
process.env.VM2API_ALLOW_PRIVATE_PROXY = '1'

const reset = Date.parse('2026-10-17T01:00:00.000Z')
const vm = { id: 'vm-01', status: 'running', has_refresh: true, proxy: { host: '127.0.0.1', port: 1080 } }
function account(id = 'account-a', extra = {}) {
  return {
    account_id: id,
    unified: {
      headers: { '5h': { utilization: 1, reset: new Date(reset).toISOString(), stale_reason: 'reset_elapsed' } },
      ...extra,
    },
  }
}
function fixture({ config = {}, accounts = [account()], active = false, result = { ok: true } } = {}) {
  let now = reset
  const calls = []
  const targets = accounts.map((_, i) => ({ ...vm, id: `vm-${String(i + 1).padStart(2, '0')}` }))
  const monitor = createUsageProbeMonitor({
    config: { reset_delay_sec: 120, reset_jitter_sec: 600, ...config },
    now: () => now,
    listTargets: () => targets,
    accountForVm: (target) => accounts[targets.indexOf(target)],
    isActive: () => active,
    probeOne: async (target) => {
      calls.push({ id: target.id, at: now })
      return result
    },
  })
  return {
    monitor,
    calls,
    setNow: (n) => {
      now = n
    },
  }
}

test('reset delay is opt-in and bounded; normalization preserves zero', () => {
  const defaults = normalizeUsageProbeConfig()
  assert.equal(defaults.reset_delay_sec, 0)
  assert.equal(defaults.reset_jitter_sec, 0)
  const cfg = normalizeUsageProbeConfig({ reset_delay_sec: 9000, reset_jitter_sec: -1 })
  assert.equal(cfg.reset_delay_sec, 3600)
  assert.equal(cfg.reset_jitter_sec, 0)
  assert.equal(normalizeUsageProbeConfig({ reset_delay_sec: '120', reset_jitter_sec: '600' }).reset_jitter_sec, 600)
})

test('default settings retain immediate elapsed-window probing', async () => {
  const f = fixture({ config: { reset_delay_sec: 0, reset_jitter_sec: 0 } })
  assert.equal((await f.monitor.runOnce()).due, 1)
  assert.equal(f.calls.length, 1)
})

test('elapsed 5h accounts have stable per-account deadlines, not one fleet deadline', async () => {
  const accounts = [account('account-a'), account('account-b'), account('account-c')]
  const f = fixture({ accounts })
  const run = await f.monitor.runOnce()
  assert.equal(run.due, 0)
  assert.equal(f.calls.length, 0)
  const times = run.items.map((item) => {
    assert.equal(item.reason, 'reset_probe_delay')
    const at = Date.parse(item.next_probe_at)
    assert.ok(at >= reset + 120_000 && at <= reset + 720_000)
    return at
  })
  assert.ok(new Set(times).size > 1)
  // Repeated ticks cannot redraw jitter and postpone a deadline indefinitely.
  f.setNow(reset + 1000)
  assert.deepEqual(
    (await f.monitor.runOnce()).items.map((x) => x.next_probe_at),
    run.items.map((x) => x.next_probe_at),
  )
  // Restart and VM-list ordering changes do not move an account's deadline.
  const reversed = fixture({ accounts: [...accounts].reverse() })
  assert.deepEqual(
    (await reversed.monitor.runOnce()).items.map((x) => x.next_probe_at).reverse(),
    run.items.map((x) => x.next_probe_at),
  )
  f.setNow(reset + 720_000)
  assert.equal((await f.monitor.runOnce()).due, 3)
  assert.equal(f.calls.length, 3)
})

test('fixed post-reset delay releases exactly at the boundary', async () => {
  const f = fixture({ config: { reset_jitter_sec: 0 } })
  f.setNow(reset + 119_999)
  assert.equal((await f.monitor.runOnce()).due, 0)
  f.setNow(reset + 120_000)
  assert.equal((await f.monitor.runOnce()).due, 1)
  assert.equal(f.calls[0].at, reset + 120_000)
})

for (const extra of [{}, { account_tier: 'pro', fable: { plan_denied: true } }]) {
  test(`active/stale and tier-recheck paths cannot bypass a pending reset delay (${extra.account_tier || 'unknown'})`, async () => {
    const f = fixture({ accounts: [account('account-a', extra)], active: true })
    assert.equal((await f.monitor.runOnce()).due, 0)
    assert.equal(f.calls.length, 0)
  })
}

test('manual/event probe remains immediate and shares existing backoff', async () => {
  const f = fixture({ result: { ok: false } })
  assert.equal((await f.monitor.runOnce()).due, 0)
  assert.equal((await f.monitor.probeNow('vm-01')).ok, false)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.monitor.probeNow('vm-01')).reason, 'probe_backoff')
  assert.equal(f.calls.length, 1)
})

test('a successful post-reset sample is not held again by the old reset', async () => {
  const a = account()
  const f = fixture({ accounts: [a], active: true, config: { reset_delay_sec: 600, reset_jitter_sec: 0 } })
  assert.equal((await f.monitor.runOnce()).due, 0)
  a.unified.last_probe = { at: new Date(reset + 1000).toISOString(), ok: true }
  f.setNow(reset + 400_000)
  // Active freshness is overdue; a prior post-reset hop already consumed the delay.
  assert.equal((await f.monitor.runOnce()).due, 1)
})

test('official usage backoff still wins and no wait item erases it', async () => {
  const f = fixture({
    accounts: [account('account-a', { usage_rate_limited_until: new Date(reset + 900_000).toISOString() })],
  })
  const run = await f.monitor.runOnce()
  assert.equal(run.due, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(run.items[0].reason, 'reconcile_extra')
})

test('seven-day-only elapsed and never-sampled accounts are not delayed', async () => {
  const f = fixture({
    accounts: [
      account('weekly', { headers: { '7d': { reset: new Date(reset).toISOString() } } }),
      { account_id: 'new' },
    ],
  })
  assert.equal((await f.monitor.runOnce()).due, 2)
})

test('missing/invalid 5h reset cannot invent a deadline', async () => {
  const f = fixture({
    accounts: [account('unknown', { headers: { '5h': { stale_reason: 'reset_elapsed', reset: 'invalid' } } })],
  })
  assert.equal((await f.monitor.runOnce()).due, 1)
})

test('future 5h reset does not delay active freshness sampling', async () => {
  const f = fixture({
    accounts: [
      account('future', { headers: { '5h': { reset: new Date(reset + 3600_000).toISOString(), utilization: 0.2 } } }),
    ],
    active: true,
  })
  assert.equal((await f.monitor.runOnce()).due, 1)
})

test('routing updates preserve delay config and propagate it to the monitor', async () => {
  const { createRoutingRuntime } = await import('../../src/lib/admin/routing-runtime.mjs')
  const f = fixture({ config: { reset_delay_sec: 0, reset_jitter_sec: 0 } })
  const ctx = {
    routingConfig: {},
    usageProbeMonitor: { setConfig: (cfg) => f.monitor.setConfig(cfg, { restart: false }) },
  }
  const runtime = createRoutingRuntime(ctx)
  runtime.applyUsageProbeRoutingBody({ usage_probe: { reset_delay_sec: 120, reset_jitter_sec: 600 } })
  assert.equal(ctx.routingConfig.usage_probe.reset_delay_sec, 120)
  assert.equal(f.monitor.getConfig().reset_jitter_sec, 600)
  assert.equal((await f.monitor.runOnce()).due, 0)
  runtime.applyUsageProbeRoutingBody({ usage_probe: { concurrency: 1 } }, ctx.routingConfig.usage_probe)
  assert.equal(f.monitor.getConfig().reset_delay_sec, 120)
  assert.equal(f.monitor.getConfig().reset_jitter_sec, 600)
  runtime.applyUsageProbeRoutingBody({ usage_probe: { reset_delay_sec: 0, reset_jitter_sec: 0 } })
  assert.equal((await f.monitor.runOnce()).due, 1)
})

test('config changes apply without retaining stale delay state', async () => {
  const f = fixture()
  assert.equal((await f.monitor.runOnce()).due, 0)
  f.monitor.setConfig({ reset_delay_sec: 0, reset_jitter_sec: 0 }, { restart: false })
  assert.equal((await f.monitor.runOnce()).due, 1)
})
