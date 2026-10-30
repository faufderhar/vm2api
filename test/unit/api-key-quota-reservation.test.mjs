import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

// L-1 (DEEP_AUDIT_2026-10-30): quota was checked at admission without reserving anything, so
// N concurrent requests on a key with one request left all passed and all got billed.

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-reserve-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return new ApiKeyStore({ dataDir: dir })
}

test('request quota: in-flight requests reserve their count; a failure gives it back', (t) => {
  const store = tmpStore(t)
  const rec = store.create({ name: 'burst', quota_requests: 2 })
  assert.equal(store.acquire(rec).ok, true)
  assert.equal(store.acquire(rec).ok, true)
  const third = store.acquire(rec)
  assert.equal(third.ok, false)
  assert.equal(third.code, 'api_key_quota_inflight')
  assert.equal(third.status, 429)
  // One fails (released, not billed): its share is free again.
  store.release(rec)
  assert.equal(store.acquire(rec).ok, true)
  // Both finish and are billed: the quota is now plainly exhausted.
  store.recordUsage(rec, { input_tokens: 1, output_tokens: 1, cost: 0 })
  store.release(rec)
  const billed = store.recordUsage(rec, { input_tokens: 1, output_tokens: 1, cost: 0 })
  store.release(rec)
  assert.equal(billed.quota_requests_used, 2)
  assert.equal(store.canAccept(billed).code, 'api_key_quota_exhausted')
})

test('USD quota: in-flight requests reserve the smoothed per-request cost', (t) => {
  const store = tmpStore(t)
  let rec = store.create({ name: 'usd', quota: 10 })
  // Nothing known yet: the first request is admitted without a reservation.
  assert.equal(store.acquire(rec).ok, true)
  rec = store.recordUsage(rec, { cost: 3 })
  store.release(rec)
  // Learned ~3 per request; 3 used. Two in flight reserve ~6: 3 + 6 < 10 still admits a third,
  // 3 + 9 >= 10 refuses a fourth.
  assert.equal(store.acquire(rec).ok, true)
  assert.equal(store.acquire(rec).ok, true)
  assert.equal(store.acquire(rec).ok, true)
  const fourth = store.acquire(rec)
  assert.equal(fourth.code, 'api_key_quota_inflight')
  assert.ok(fourth.detail.reserved >= 9)
  for (let i = 0; i < 3; i++) store.release(rec)
  assert.equal(store.acquire(rec).ok, true, 'released requests free their reservation')
  store.release(rec)
})

test('open spend windows carry the reservation; nothing in flight leaves the old gate unchanged', (t) => {
  const store = tmpStore(t)
  let rec = store.create({ name: 'window', rate_limit_5h: 5 })
  assert.equal(store.acquire(rec).ok, true)
  rec = store.recordUsage(rec, { cost: 2 })
  store.release(rec)
  assert.equal(store.canAccept(rec).ok, true)
  assert.equal(store.acquire(rec).ok, true)
  // 2 used + 1 in flight × ~2 = 4 < 5: admitted; + 2 in flight = 6 >= 5: refused.
  assert.equal(store.acquire(rec).ok, true)
  assert.equal(store.acquire(rec).code, 'api_key_quota_inflight')
  store.release(rec)
  store.release(rec)
  assert.equal(store.canAccept(rec).ok, true)
})
