import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { NODE_HOST_COMMAND, parseNodeHost } from '../../src/lib/cluster/node-host.mjs'

const SAMPLE = [
  'ncpu 2',
  'load 0.50 0.40 0.30 1/234 5678',
  'MemTotal:        2000000 kB',
  'MemAvailable:     500000 kB',
  'cg 300000000 100000000',
  'cg 50000000 ',
  '',
].join('\n')

test('parseNodeHost uses the local host column scale', () => {
  assert.deepEqual(parseNodeHost(SAMPLE), {
    cpu_count: 2,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    cpu_pct: 25,
    mem_total: 2_048_000_000,
    mem_used: 1_536_000_000,
    mem_pct: 75,
    containers_mem: 250_000_000,
  })
})

test('parseNodeHost caps CPU at 100% and reports no containers as null', () => {
  const host = parseNodeHost(SAMPLE.replace('load 0.50', 'load 9.00').replace(/^cg .*$/gm, ''))
  assert.equal(host.cpu_pct, 100)
  assert.equal(host.containers_mem, null)
})

test('parseNodeHost returns null when essentials are missing', () => {
  assert.equal(parseNodeHost(''), null)
  assert.equal(parseNodeHost(SAMPLE.replace(/^MemAvailable:.*$/m, '')), null)
  assert.equal(parseNodeHost(SAMPLE.replace('ncpu 2', 'ncpu ')), null)
})

test('NODE_HOST_COMMAND runs on Linux and parses', { skip: process.platform !== 'linux' }, () => {
  const host = parseNodeHost(execFileSync('sh', ['-c', NODE_HOST_COMMAND], { encoding: 'utf8' }))
  assert.ok(host && host.cpu_count >= 1 && host.mem_total > 0)
})
