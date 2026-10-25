import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asBool, clampPositiveInt } from '../../src/lib/core/config-values.mjs'
import { mapPool } from '../../src/lib/core/map-pool.mjs'
import { createPeriodicTask } from '../../src/lib/core/periodic-task.mjs'

test('asBool accepts env-style strings and keeps fallback otherwise', () => {
  assert.equal(asBool(undefined, true), true)
  assert.equal(asBool(null, false), false)
  assert.equal(asBool(false, true), false)
  for (const v of ['true', '1', ' YES ', 'on']) assert.equal(asBool(v, false), true)
  for (const v of ['false', '0', 'no', 'OFF']) assert.equal(asBool(v, true), false)
  assert.equal(asBool('maybe', true), true)
})

test('clampPositiveInt rounds, clamps and rejects non-positive input', () => {
  assert.equal(clampPositiveInt('42.6', 1, 100, 7), 43)
  assert.equal(clampPositiveInt(5, 10, 100, 7), 10)
  assert.equal(clampPositiveInt(500, 10, 100, 7), 100)
  assert.equal(clampPositiveInt(0, 0, 100, 7), 7)
  assert.equal(clampPositiveInt(-3, 0, 100, 7), 7)
  assert.equal(clampPositiveInt('x', 0, 100, 7), 7)
  assert.equal(clampPositiveInt(Infinity, 0, 100, 7), 7)
})

test('mapPool keeps order and bounds concurrency', async () => {
  let inflight = 0
  let peak = 0
  const out = await mapPool([30, 10, 20, 5], 2, async (ms, i) => {
    inflight++
    peak = Math.max(peak, inflight)
    await new Promise((r) => setTimeout(r, ms))
    inflight--
    return `${i}:${ms}`
  })
  assert.deepEqual(out, ['0:30', '1:10', '2:20', '3:5'])
  assert.equal(peak, 2)
  assert.deepEqual(await mapPool([], 4, async () => 1), [])
})

test('createPeriodicTask honours enabled/run_on_start and stop', async () => {
  let runs = 0
  let config = { enabled: false, interval_sec: 3600, run_on_start: true }
  const task = createPeriodicTask(
    async () => {
      runs++
    },
    () => config,
  )
  assert.deepEqual(task.start({ immediate: true }), { started: false, reason: 'disabled' })
  config = { enabled: true, interval_sec: 3600, run_on_start: true }
  assert.deepEqual(task.start({ immediate: true }), { started: true, interval_sec: 3600, run_on_start: true })
  await new Promise((r) => setImmediate(r))
  assert.equal(runs, 1)
  task.start({ immediate: false })
  await new Promise((r) => setImmediate(r))
  assert.equal(runs, 1)
  task.stop()
  task.stop()
  const failing = createPeriodicTask(
    async () => {
      throw new Error('boom')
    },
    () => config,
  )
  failing.start({ immediate: true })
  await new Promise((r) => setImmediate(r))
  failing.stop()
})
