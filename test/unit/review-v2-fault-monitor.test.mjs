import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createFaultMonitor } from '../../src/lib/core/fault-monitor.mjs'

function logger() {
  const lines = []
  return { lines, error: (...a) => lines.push(a.map(String).join(' ')) }
}

test('L-11: default keeps serving, counts every fault, rate-limits the log', () => {
  let t = 0
  const log = logger()
  let fatal = 0
  const m = createFaultMonitor({
    env: {},
    logger: log,
    onFatal: () => fatal++,
    now: () => t,
    logsPerWindow: 2,
    windowMs: 1000,
  })
  for (let i = 0; i < 10; i++) m.onUncaughtException(new Error(`boom ${i}`))
  m.onUnhandledRejection(new Error('rej'))
  assert.equal(m.counts.uncaughtException, 10)
  assert.equal(m.counts.unhandledRejection, 1)
  assert.equal(log.lines.filter((l) => l.startsWith('[uncaught]')).length, 2)
  t = 1500
  m.onUncaughtException(new Error('later'))
  assert.ok(log.lines.some((l) => /8 more suppressed/.test(l)))
  assert.equal(fatal, 0)
  assert.equal(m.exitOnUncaught, false)
})

test('L-11: VM2API_EXIT_ON_UNCAUGHT=1 triggers one graceful shutdown; rejections never do', () => {
  const log = logger()
  let fatal = 0
  const m = createFaultMonitor({ env: { VM2API_EXIT_ON_UNCAUGHT: '1' }, logger: log, onFatal: () => fatal++ })
  m.onUnhandledRejection(new Error('rej'))
  assert.equal(fatal, 0)
  m.onUncaughtException(new Error('a'))
  m.onUncaughtException(new Error('b'))
  assert.equal(fatal, 1)
})

test('L-11: install wires both process events', () => {
  const proc = new EventEmitter()
  const m = createFaultMonitor({ env: {}, logger: logger() }).install(proc)
  proc.emit('uncaughtException', new Error('x'))
  proc.emit('unhandledRejection', new Error('y'))
  assert.deepEqual(m.counts, { uncaughtException: 1, unhandledRejection: 1 })
})
