import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildVmList } from '../../src/lib/admin/panel-api.mjs'

function grokSlotRoot(t, bag = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-grok-cost-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-g1.json'),
    JSON.stringify({ id: 'vm-g1', platform: 'xai', family: 'grok', status: 'active', grok: bag }),
  )
  return root
}

async function grokListRow(root, accounts) {
  const listed = await buildVmList({
    cfg: { paths: { project: root } },
    accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
    routingConfig: {},
    requestLog: { billingStats: () => ({ accounts }) },
  })
  return listed.data.items.find((vm) => vm.id === 'vm-g1')
}

test('Grok cost columns sum the slot-keyed rows and the account-keyed rows', async (t) => {
  const root = grokSlotRoot(t, { email: 'grok-a@example.test' })
  // Before the Grok hop logged its account, rows fell back to the slot id.
  const legacy = {
    account_id: 'vm-g1',
    vm_id: 'vm-g1',
    requests: 2,
    total_cost: 12,
    input_tokens: 100,
    window_7d_cost: 2,
    window_7d_requests: 1,
    window_5h_cost: 0,
    today: { requests: 0, total_cost: 0 },
    window_7d: { requests: 1, total_cost: 2 },
  }
  const current = {
    account_id: 'grok-a@example.test',
    vm_id: 'vm-g1',
    requests: 1,
    today_requests: 1,
    today_cost: 1,
    total_cost: 1,
    input_tokens: 10,
    window_5h_cost: 1,
    window_7d_cost: 1,
    window_7d_requests: 1,
    today: { requests: 1, total_cost: 1 },
    window_7d: { requests: 1, total_cost: 1 },
  }
  const row = await grokListRow(root, [legacy, current])
  assert.equal(row.total_cost, 13)
  assert.equal(row.window_7d_cost, 3)
  assert.equal(row.window_7d_requests, 2)
  assert.equal(row.window_5h_cost, 1)
  assert.equal(row.today_cost, 1)
  assert.equal(row.total_tokens, 110)
  // Order of the billing rows must not change the answer.
  const swapped = await grokListRow(root, [current, legacy])
  assert.equal(swapped.total_cost, 13)
  assert.equal(swapped.window_7d_cost, 3)
})

test('Grok cost columns leave out an earlier account on a reused slot', async (t) => {
  const root = grokSlotRoot(t, { email: 'grok-b@example.test' })
  const row = await grokListRow(root, [
    { account_id: 'grok-a@example.test', vm_id: 'vm-g1', requests: 9, total_cost: 50, window_7d_cost: 5 },
    { account_id: 'grok-b@example.test', vm_id: 'vm-g1', requests: 1, total_cost: 2, window_7d_cost: 2 },
  ])
  assert.equal(row.total_cost, 2)
  assert.equal(row.window_7d_cost, 2)
})

test('Grok cost columns from a real usage_logs table match hand sums', async (t) => {
  const { createDatabase } = await import('../../src/lib/db/database.mjs')
  const { UsageLogsRepo } = await import('../../src/lib/db/repos/usage-logs-repo.mjs')
  const root = grokSlotRoot(t, { email: 'grok-a@example.test' })
  const db = createDatabase({ dataDir: path.join(root, 'data') })
  t.after(() => db.close?.())
  const logs = new UsageLogsRepo(db)
  const now = Date.now()
  const HOUR = 3600e3
  let n = 0
  const insert = (partial, agoMs) =>
    logs.insertSummary({
      id: `l${++n}`,
      request_id: `r${n}`,
      status: 200,
      input_tokens: 10,
      output_tokens: 5,
      pricing_model: 'fixture',
      vm_id: 'vm-g1',
      created_at: new Date(now - agoMs).toISOString(),
      ...partial,
    })
  insert({ total_cost: 10 }, 20 * 24 * HOUR)
  insert({ total_cost: 2 }, 3 * 24 * HOUR)
  insert({ account_id: 'grok-a@example.test', final_account_id: 'grok-a@example.test', total_cost: 1 }, 2 * HOUR)
  const listed = await buildVmList({
    cfg: { paths: { project: root } },
    accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
    routingConfig: {},
    requestLog: { billingStats: (opts) => logs.billingStats(opts), costByModel: () => [] },
  })
  const row = listed.data.items.find((vm) => vm.id === 'vm-g1')
  assert.equal(row.total_cost, 13)
  assert.equal(row.window_7d_cost, 3)
  assert.equal(row.window_5h_cost, 1)
})
