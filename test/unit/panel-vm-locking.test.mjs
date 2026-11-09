import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { atomicWriteJson, withVmLock } from '../../src/lib/vm/vm-file.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-lock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-1', 'cli-home'), { recursive: true })
  const vmPath = path.join(root, 'vms', 'vm-1.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({ id: 'vm-1', platform: 'anthropic', family: 'claude', status: 'stopped', kernel: 'ubuntu-22.04' }),
  )
  return { root, vmPath }
}

function call(root, method, url, body) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    requireAuth(req) {
      Object.assign(req, { apiKeyKind: 'master', panelRole: 'admin' })
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
  })
  return handlePanel({ method, headers: {} }, {}, new URL(`http://localhost${url}`)).then(() => response)
}

/** A credential import in progress: it read the record and will write its copy back. */
function importInProgress(vmPath) {
  let finish
  const held = new Promise((resolve) => {
    finish = resolve
  })
  const done = withVmLock(vmPath, async () => {
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    await held
    vm.worker_credential = 'imported'
    atomicWriteJson(vmPath, vm, { mode: 0o600 })
  })
  return { finish, done }
}

// Long enough for the route to run up to its first write or its wait on the lock.
const tick = () => new Promise((resolve) => setTimeout(resolve, 50))
const readVm = (vmPath) => JSON.parse(fs.readFileSync(vmPath, 'utf8'))

test('seed settings saved during a credential import keep both', async (t) => {
  const { root, vmPath } = fixture(t)
  const running = importInProgress(vmPath)
  const route = call(root, 'PUT', '/api/panel/vms/vm-1/seed-settings', { theme: 'light' })
  await tick()
  running.finish()
  await running.done
  const out = await route
  assert.equal(out.status, 200, JSON.stringify(out.body))
  const saved = readVm(vmPath)
  assert.equal(saved.worker_credential, 'imported')
  assert.equal(saved.seed_policy.theme, 'light')
})

test('a fingerprint reset during a credential import keeps both', async (t) => {
  const { root, vmPath } = fixture(t)
  const running = importInProgress(vmPath)
  const route = call(root, 'POST', '/api/panel/vms/vm-1/reset-fingerprint', {})
  let answered = false
  route.then(() => {
    answered = true
  })
  await tick()
  assert.equal(answered, false, 'the reset waits for the import to finish')
  running.finish()
  await running.done
  const out = await route
  assert.equal(out.status, 200, JSON.stringify(out.body))
  const saved = readVm(vmPath)
  assert.equal(saved.worker_credential, 'imported')
  assert.ok(saved.fingerprint)
})

test('a stop during a credential import keeps both and records the halted runtime', async (t) => {
  const { root, vmPath } = fixture(t)
  fs.writeFileSync(
    vmPath,
    JSON.stringify({ ...readVm(vmPath), status: 'running', runtime: { type: 'docker', pid: 42 } }),
  )
  const running = importInProgress(vmPath)
  const route = call(root, 'POST', '/api/panel/vms/vm-1/stop', {})
  await tick()
  running.finish()
  await running.done
  const out = await route
  assert.equal(out.status, 200, JSON.stringify(out.body))
  const saved = readVm(vmPath)
  assert.equal(saved.worker_credential, 'imported')
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.schedule_disabled_reason, 'stopped')
  assert.equal(saved.runtime.pid, null)
})

test('seed settings for a Grok slot are still refused', async (t) => {
  const { root, vmPath } = fixture(t)
  fs.writeFileSync(vmPath, JSON.stringify({ id: 'vm-1', platform: 'grok', family: 'grok' }))
  const out = await call(root, 'PUT', '/api/panel/vms/vm-1/seed-settings', { theme: 'light' })
  assert.equal(out.status, 409)
  assert.equal(out.body.error.code, 'grok_no_seed_policy')
})
