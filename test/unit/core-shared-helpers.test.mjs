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

test('clock helpers', async () => {
  const { sleep, nowIso } = await import('../../src/lib/core/clock.mjs')
  const t0 = Date.now()
  await sleep(15)
  assert.ok(Date.now() - t0 >= 10)
  assert.ok(!Number.isNaN(Date.parse(nowIso())))
  assert.match(nowIso(), /^\d{4}-\d\d-\d\dT.*Z$/)
})

test('splitQemuOpts treats ,, as a literal comma', async () => {
  const { splitQemuOpts } = await import('../../src/lib/identity/qemu-opts.mjs')
  assert.deepEqual(splitQemuOpts('type=1,manufacturer=A,,B,serial=x'), ['type=1', 'manufacturer=A,B', 'serial=x'])
  assert.deepEqual(splitQemuOpts(''), [''])
  assert.deepEqual(splitQemuOpts('a,'), ['a', ''])
})

test('claude PTY session helpers', async () => {
  const m = await import('../../src/lib/oauth/claude-pty-session.mjs')
  const url = 'https://claude.com/cai/oauth/authorize?code=true&state=abc'
  assert.equal(m.extractCaiAuthorizeUrl(`\x1b]8;;${url}\x07link`), url)
  assert.equal(m.extractCaiAuthorizeUrl(`visit:\r\n ${url.slice(0, 30)}\n${url.slice(30)}\n`), url)
  assert.equal(m.pidAlive(process.pid), true)
  assert.equal(m.pidAlive(0), false)
  let n = 0
  assert.equal(await m.waitFor(() => ++n >= 2 && 'done', 1000, 5), 'done')
  assert.equal(await m.waitFor(() => null, 20, 5), null)
  const view = m.ptySessionView({ session_id: 's', expires_at: 1 }, 'vm1', { alive: true, flavor: 'f', source: 'x' })
  assert.equal(view.vm_id, 'vm1')
  assert.equal(view.expired, true)
  assert.equal(m.codedError('c', 'msg').code, 'c')
})

test('proc, client-gone, parsed clamp and JSON column helpers', async () => {
  const { pidAlive, existingBin } = await import('../../src/lib/core/proc.mjs')
  const { clientGoneSignal } = await import('../../src/lib/protocol/client-gone.mjs')
  const { clampParsedInt } = await import('../../src/lib/core/config-values.mjs')
  const { parseJsonColumn } = await import('../../src/lib/db/database.mjs')
  const { EventEmitter } = await import('node:events')
  assert.equal(pidAlive(process.pid), true)
  assert.equal(existingBin(process.execPath), process.execPath)
  assert.equal(existingBin('/definitely/not/here'), '')
  assert.equal(existingBin(''), '')
  const req = new EventEmitter()
  const res = new EventEmitter()
  const gone = clientGoneSignal(req, res)
  assert.equal(gone.signal.aborted, false)
  res.emit('close')
  assert.equal(gone.signal.aborted, true)
  gone.settle()
  assert.equal(res.listenerCount('close'), 0)
  assert.equal(clampParsedInt('12px', 1, 10, 5), 10)
  assert.equal(clampParsedInt('-3', 0, 10, 5), 0)
  assert.equal(clampParsedInt('x', 0, 10, 5), 5)
  assert.deepEqual(parseJsonColumn('{"a":1}'), { a: 1 })
  assert.equal(parseJsonColumn(null, 7), 7)
  assert.equal(parseJsonColumn('{bad', 'fb'), 'fb')
})
