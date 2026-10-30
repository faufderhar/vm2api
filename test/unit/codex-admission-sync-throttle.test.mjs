import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CODEX_SCHEDULE_SYNC_MS,
  codexScheduleSyncDue,
  pickCodexCandidates,
  resetCodexScheduleSync,
} from '../../src/lib/protocol/handle-codex.mjs'

// L-3 (DEEP_AUDIT_2026-10-30): every Codex admission swept all slot files (listVms + getVm +
// syncCodexQuotaSchedule, which can write). The sweep is now throttled per project.

test('the admission sweep runs at most once per interval per project', () => {
  resetCodexScheduleSync()
  const t0 = 1_000_000
  assert.equal(codexScheduleSyncDue('/p1', t0), true)
  assert.equal(codexScheduleSyncDue('/p1', t0 + 1), false)
  assert.equal(codexScheduleSyncDue('/p2', t0 + 1), true, 'projects are independent')
  assert.equal(codexScheduleSyncDue('/p1', t0 + CODEX_SCHEDULE_SYNC_MS - 1), false)
  assert.equal(codexScheduleSyncDue('/p1', t0 + CODEX_SCHEDULE_SYNC_MS), true)
  // A clock that stepped backwards does not freeze the sweep.
  assert.equal(codexScheduleSyncDue('/p1', t0), true)
})

test('back-to-back admissions read each slot file once per sweep, not once per request', (t) => {
  resetCodexScheduleSync()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sync-throttle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-a'), { recursive: true })
  const file = path.join(root, 'vms', 'vm-a.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ id: 'vm-a', platform: 'openai', family: 'codex', status: 'running', schedulable: true }),
  )
  const reads = []
  const orig = fs.readFileSync
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (String(p) === file) reads.push(p)
    return orig.call(this, p, ...rest)
  })
  const req = { headers: {}, apiKeyKind: 'master' }
  pickCodexCandidates(root, req, { body: {} })
  const first = reads.length
  for (let i = 0; i < 5; i++) pickCodexCandidates(root, req, { body: {} })
  const perRequest = (reads.length - first) / 5
  assert.ok(perRequest < first, `per-request reads ${perRequest} must drop below the sweeping request's ${first}`)
})
