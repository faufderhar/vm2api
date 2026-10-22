import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectContainerOutcome } from '../../src/lib/vm/vm-runtime.mjs'
import { isDockerInspectNotFound } from '../../src/lib/vm/docker-container.mjs'

test('isDockerInspectNotFound matches docker inspect stderr for absent names', () => {
  assert.equal(isDockerInspectNotFound({ stderr: 'Error: No such object: kin-05' }), true)
  assert.equal(isDockerInspectNotFound({ stderr: 'Error response from daemon: No such container: kin-05' }), true)
  assert.equal(isDockerInspectNotFound({ stderr: 'Cannot connect to the Docker daemon' }), false)
})

test('inspectContainerOutcome: missing container', () => {
  const outcome = inspectContainerOutcome('kin-ghost', {
    run: () => ({
      ok: false,
      stderr: 'Error: No such object: kin-ghost',
      stdout: '',
      code: 1,
    }),
  })
  assert.deepEqual(outcome, { status: 'missing' })
})

test('inspectContainerOutcome: daemon down is an error, not missing', () => {
  const outcome = inspectContainerOutcome('kin-01', {
    run: () => ({
      ok: false,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      stdout: '',
      code: 1,
    }),
  })
  assert.equal(outcome.status, 'error')
  assert.match(outcome.error, /Cannot connect/)
})

test('inspectContainerOutcome: found parses running state', () => {
  const outcome = inspectContainerOutcome('kin-01', {
    run: () => ({
      ok: true,
      stdout: 'true|12345|kin-px-net|2026-01-01T00:00:00Z|img|host|docker||false',
      stderr: '',
    }),
  })
  assert.equal(outcome.status, 'found')
  assert.equal(outcome.container.running, true)
  assert.equal(outcome.container.pid, 12345)
})
