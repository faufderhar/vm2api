import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  grokBuildUsageFresh,
  grokCreditUsedPercent,
  parseGrokBuildBilling,
  queryGrokBuildUsage,
} from '../../src/lib/oauth/grok-build-usage.mjs'
import { upsertGrokAccount } from '../../src/lib/vm/grok-slot.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { enrichVm } from '../../src/lib/admin/panel-api.mjs'
import { grokUsageProbeTiming } from '../../src/lib/oauth/grok-refresh-monitor.mjs'

test('Grok Build credit percent is percent points above 1 and a fraction at or below 1', () => {
  assert.equal(grokCreditUsedPercent(37), 37)
  assert.equal(grokCreditUsedPercent(0.37), 37)
  assert.equal(grokCreditUsedPercent(1), 100)
  assert.equal(grokCreditUsedPercent(140), 100)
  assert.equal(grokCreditUsedPercent(null), null)
})

test('billing response maps the weekly pool and the latest monthly included spend', () => {
  const usage = parseGrokBuildBilling({
    config: {
      creditUsagePercent: 37,
      currentPeriod: { start: '2026-10-12T00:00:00.000Z', end: '2026-10-19T00:00:00.000Z' },
      monthlyLimit: 20,
      onDemandCap: 10,
      onDemandUsed: 1.5,
      prepaidBalance: 4,
      history: [
        { includedUsed: 1, totalUsed: 1 },
        { includedUsed: 6, totalUsed: 7.5 },
      ],
    },
    on_demand_enabled: true,
    subscription_tier: 'super',
  })
  assert.equal(usage.credit_usage_percent, 37)
  assert.equal(usage.period_end, '2026-10-19T00:00:00.000Z')
  assert.equal(usage.included_used, 6)
  assert.equal(usage.total_used, 7.5)
  assert.equal(usage.monthly_limit, 20)
  assert.equal(usage.on_demand_enabled, true)
  assert.equal(usage.subscription_tier, 'super')
  assert.equal(parseGrokBuildBilling({}), null)
})

test('wrapped billing amounts and the ledger fill the monthly window', () => {
  const usage = parseGrokBuildBilling(
    {
      config: {
        creditUsagePercent: 12,
        currentPeriod: { end: '2026-10-23T14:03:01.773Z' },
        onDemandCap: { val: 0 },
        prepaidBalance: { val: 0 },
      },
    },
    {
      config: {
        monthlyLimit: { val: 0 },
        history: [
          { billingCycle: { year: 2026, month: 7 }, includedUsed: { val: 0 }, totalUsed: { val: 0 } },
          { billingCycle: { year: 2026, month: 10 }, includedUsed: { val: 6 }, totalUsed: { val: 7.5 } },
          { billingCycle: { year: 2026, month: 8 }, includedUsed: { val: 1 }, totalUsed: { val: 1 } },
        ],
      },
    },
  )
  assert.equal(usage.credit_usage_percent, 12)
  assert.equal(usage.monthly_limit, 0)
  assert.equal(usage.included_used, 6)
  assert.equal(usage.total_used, 7.5)
  assert.equal(usage.on_demand_cap, 0)
  assert.equal(usage.period_end, '2026-10-23T14:03:01.773Z')
  assert.equal(usage.subscription_tier, null)
})

test('subscription tier is read from the credits config or the ledger', () => {
  const credits = { config: { creditUsagePercent: 5 } }
  assert.equal(
    parseGrokBuildBilling({ config: { creditUsagePercent: 5, subscriptionTier: 'SuperGrokHeavy' } }).subscription_tier,
    'SuperGrokHeavy',
  )
  assert.equal(parseGrokBuildBilling(credits, { subscriptionTier: 'super' }).subscription_tier, 'super')
  assert.equal(parseGrokBuildBilling(credits, { config: { subscription_tier: 'heavy' } }).subscription_tier, 'heavy')
})

test('a fresh Grok Build sample is not fetched again until it is stale', () => {
  const now = Date.parse('2026-10-19T03:00:00.000Z')
  assert.equal(
    grokBuildUsageFresh({ ok: true, credit_usage_percent: 10, probed_at: '2026-10-19T02:56:00.000Z' }, now),
    true,
  )
  assert.equal(
    grokBuildUsageFresh({ ok: true, credit_usage_percent: 10, probed_at: '2026-10-19T02:50:00.000Z' }, now),
    false,
  )
  assert.equal(
    grokBuildUsageFresh({ ok: false, credit_usage_percent: null, probed_at: '2026-10-19T02:50:00.000Z' }, now),
    false,
  )
})

function writeGrokVm(root, id) {
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'xai',
      family: 'grok',
      proxy: { id: 'px-local', scheme: 'local' },
      grok: { has_access: true },
    }),
  )
}

test('query stores Grok Build billing and keeps the last good sample after a failed hop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-'))
  writeGrokVm(root, 'heavy')
  upsertGrokAccount(root, 'heavy', {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 60 * 60 * 1000,
  })
  const calls = []
  const forward = async (envelope) => {
    calls.push(envelope)
    const body =
      envelope.query === 'format=credits'
        ? {
            config: {
              creditUsagePercent: 37,
              monthlyLimit: 20,
              currentPeriod: { end: '2026-10-26T00:00:00.000Z' },
              history: [{ includedUsed: 4, totalUsed: 4 }],
            },
            subscription_tier: 'super',
          }
        : {
            config: {
              monthlyLimit: { val: 20 },
              history: [{ billingCycle: { year: 2026, month: 10 }, includedUsed: { val: 4 }, totalUsed: { val: 4 } }],
            },
          }
    assert.equal(envelope.purpose, 'billing')
    assert.equal(envelope.path, '/v1/billing')
    assert.equal('authorization' in envelope, false)
    assert.equal('access_token' in envelope, false)
    return {
      statusCode: 200,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body))
      },
    }
  }
  const now = Date.parse('2026-10-19T03:00:00.000Z')
  const first = await queryGrokBuildUsage({
    projectRoot: root,
    vmId: 'heavy',
    proxyUrl: '',
    forward,
    now,
  })
  assert.equal(first.ok, true)
  assert.equal(first.usage.credit_usage_percent, 37)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].query, 'format=credits')
  assert.equal(calls[1].query, '')
  const stored = getVm(root, 'heavy').grok.build_usage
  assert.equal(stored.credit_usage_percent, 37)
  assert.equal(stored.included_used, 4)
  assert.equal(stored.subscription_tier, 'super')

  const skipped = await queryGrokBuildUsage({
    projectRoot: root,
    vmId: 'heavy',
    proxyUrl: '',
    forward,
    now: now + 60_000,
  })
  assert.equal(skipped.skipped, true)
  assert.equal(calls.length, 2)

  const failedForward = async () => ({
    statusCode: 500,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{}')
    },
  })
  const failed = await queryGrokBuildUsage({
    projectRoot: root,
    vmId: 'heavy',
    proxyUrl: '',
    forward: failedForward,
    force: true,
    now: now + 120_000,
  })
  assert.equal(failed.ok, false)
  const kept = getVm(root, 'heavy').grok.build_usage
  assert.equal(kept.ok, false)
  assert.equal(kept.credit_usage_percent, 37)
  assert.equal(kept.error, 'upstream_error')
  assert.equal(kept.message, 'Grok Build 账单返回 500')
})

test('the panel row keeps Grok Build usage for the usage window', () => {
  const row = enrichVm(
    {
      id: 'heavy',
      status: 'running',
      platform: 'xai',
      family: 'grok',
      has_token: true,
      has_refresh: true,
      grok_build: {
        ok: true,
        credit_usage_percent: 13,
        period_end: '2026-10-23T14:03:01.773Z',
        monthly_limit: 0,
      },
    },
    null,
    null,
  )
  assert.equal(row.platform, 'xai')
  assert.equal(row.family, 'grok')
  assert.equal(row.has_token, true)
  assert.equal(row.grok_build.credit_usage_percent, 13)
})

test('Grok usage sync follows the Claude usage-window interval', () => {
  assert.deepEqual(grokUsageProbeTiming({}), { intervalMs: 60_000, staleMs: 300_000 })
  assert.deepEqual(grokUsageProbeTiming({ interval_sec: 90, stale_sec: 120 }), {
    intervalMs: 90_000,
    staleMs: 120_000,
  })
})
