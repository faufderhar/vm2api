import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_GROK_ROUTING,
  GROK_BILLING_LIMITS,
  normalizeGrokRouting,
  validateGrokRoutingPatch,
} from '../../src/lib/protocol/grok-route.mjs'
import { createGrokRefreshMonitor } from '../../src/lib/oauth/grok-refresh-monitor.mjs'

test('grok.billing defaults to background reads every 30 minutes', () => {
  assert.deepEqual(DEFAULT_GROK_ROUTING.billing, { background: true, min_interval_sec: 1800 })
  assert.deepEqual(normalizeGrokRouting({}).billing, { background: true, min_interval_sec: 1800 })
  assert.deepEqual(GROK_BILLING_LIMITS.min_interval_sec, { min: 1800, max: 86400 })
})

test('grok.billing normalizes: background only off when explicitly false, interval clamped', () => {
  assert.equal(normalizeGrokRouting({ billing: { background: false } }).billing.background, false)
  assert.equal(normalizeGrokRouting({ billing: { background: 'no' } }).billing.background, true)
  assert.equal(normalizeGrokRouting({ billing: { min_interval_sec: 60 } }).billing.min_interval_sec, 1800)
  assert.equal(normalizeGrokRouting({ billing: { min_interval_sec: 999999 } }).billing.min_interval_sec, 86400)
  assert.equal(normalizeGrokRouting({ billing: { min_interval_sec: 7200 } }).billing.min_interval_sec, 7200)
  assert.equal(normalizeGrokRouting({ billing: { min_interval_sec: 1.5 } }).billing.min_interval_sec, 1800)
})

test('PUT validation rejects bad grok.billing values', () => {
  assert.doesNotThrow(() =>
    validateGrokRoutingPatch({ grok: { billing: { background: false, min_interval_sec: 3600 } } }),
  )
  assert.throws(() => validateGrokRoutingPatch({ grok: { billing: 'x' } }), { code: 'invalid_grok_billing' })
  assert.throws(() => validateGrokRoutingPatch({ grok: { billing: { background: 'yes' } } }), {
    code: 'invalid_grok_billing',
  })
  assert.throws(() => validateGrokRoutingPatch({ grok: { billing: { min_interval_sec: 600 } } }), {
    code: 'invalid_grok_billing',
  })
  assert.throws(() => validateGrokRoutingPatch({ grok: { billing: { min_interval_sec: 90000 } } }), {
    code: 'invalid_grok_billing',
  })
})

test('PUT validation checks grok.clients keys and values', () => {
  assert.doesNotThrow(() =>
    validateGrokRoutingPatch({
      grok: {
        clients: { official_codex: 'allow', openai_compatible: 'reject', claude_code: 'allow', unknown: 'reject' },
      },
    }),
  )
  assert.throws(() => validateGrokRoutingPatch({ grok: { clients: { browser: 'allow' } } }), {
    code: 'invalid_grok_clients',
  })
  assert.throws(() => validateGrokRoutingPatch({ grok: { clients: { unknown: true } } }), {
    code: 'invalid_grok_clients',
  })
  assert.throws(() => validateGrokRoutingPatch({ grok: { clients: [] } }), { code: 'invalid_grok_clients' })
})

test('PUT validation rejects an out-of-range refresh skew instead of silently resetting it', () => {
  assert.doesNotThrow(() => validateGrokRoutingPatch({ grok: { oauth: { refresh_skew_sec: 30 } } }))
  assert.doesNotThrow(() => validateGrokRoutingPatch({ grok: { oauth: { refresh_skew_sec: 3600 } } }))
  assert.throws(() => validateGrokRoutingPatch({ grok: { oauth: { refresh_skew_sec: 10 } } }), {
    code: 'invalid_grok_oauth',
  })
  assert.throws(() => validateGrokRoutingPatch({ grok: { oauth: { refresh_skew_sec: 99.5 } } }), {
    code: 'invalid_grok_oauth',
  })
})

function grokSlot(root, id, probedAt) {
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const vm = {
    id,
    platform: 'xai',
    family: 'grok',
    status: 'running',
    has_token: true,
    proxy: { id: 'px-local', scheme: 'local' },
    grok: { has_access: true, build_usage: { ok: true, credit_usage_percent: 10, probed_at: probedAt } },
  }
  fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
  return vm
}

test('monitor skips every slot when grok.billing.background is false', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-settings-'))
  const vm = grokSlot(root, 'g1', new Date(Date.now() - 2 * 3600_000).toISOString())
  let exits = 0
  const monitor = createGrokRefreshMonitor({
    projectRoot: root,
    listTargets: () => [vm],
    getRouting: () => ({ grok: { billing: { background: false } } }),
    getUsageProbe: () => ({}),
    exitFor: () => {
      exits += 1
      return null
    },
  })
  const out = await monitor.runOnce()
  assert.equal(out.disabled, true)
  assert.deepEqual(out.items, [])
  assert.equal(exits, 0)
})

test('monitor treats a sample younger than grok.billing.min_interval_sec as fresh', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-settings-'))
  // 40 minutes old: stale under the 30 minute default, fresh under a 1 hour floor.
  const vm = grokSlot(root, 'g2', new Date(Date.now() - 40 * 60_000).toISOString())
  const run = (billing) =>
    createGrokRefreshMonitor({
      projectRoot: root,
      listTargets: () => [vm],
      getRouting: () => ({ grok: { billing } }),
      getUsageProbe: () => ({}),
      // No exit: a stale sample stops at proxy_required before any network call.
      exitFor: (slot) => (billing.min_interval_sec ? slot : null),
    }).runOnce()
  const fresh = await run({ min_interval_sec: 3600 })
  assert.equal(fresh.items[0].skipped, true)
  assert.equal(fresh.items[0].ok, true)
  const stale = await run({})
  assert.equal(stale.items[0].ok, false)
  assert.equal(stale.items[0].code, 'proxy_required')
})

test('persistRoutingPatch merges grok.billing and keeps the rest of the grok block', async () => {
  const { createRoutingRuntime } = await import('../../src/lib/admin/routing-runtime.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-settings-persist-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const routingFile = path.join(root, 'routing.json')
  const routingConfig = {
    concurrency: {},
    tiers: {},
    grok: normalizeGrokRouting({ enabled: true, clients: { claude_code: 'allow' } }),
  }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
      routingConfig,
      stickyRouter: { reloadConfig() {} },
      accountQuota: {
        setMaxConcurrency() {},
        setMaxRpm() {},
        reloadConfig() {},
        applyTierConcurrency() {},
        applyTierRpm() {},
        repo: { get: () => null },
      },
      requestLog: { setConfig() {} },
    })
    runtime.persistRoutingPatch({ grok: { billing: { min_interval_sec: 7200 } } })
    const saved = JSON.parse(fs.readFileSync(routingFile, 'utf8')).grok
    assert.deepEqual(saved.billing, { background: true, min_interval_sec: 7200 })
    assert.equal(saved.enabled, true)
    assert.equal(saved.clients.claude_code, 'allow')
    runtime.persistRoutingPatch({ grok: { billing: { background: false } } })
    const again = JSON.parse(fs.readFileSync(routingFile, 'utf8')).grok
    assert.deepEqual(again.billing, { background: false, min_interval_sec: 7200 })
    assert.throws(() => runtime.persistRoutingPatch({ grok: { billing: { min_interval_sec: 5 } } }), {
      code: 'invalid_grok_billing',
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
