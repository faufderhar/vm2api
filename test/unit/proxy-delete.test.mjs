import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

// Proxy DELETE + batch-delete (fix/proxy-delete-batch). Isolated temp data only.

process.env.VM2API_ALLOW_PRIVATE_PROXY = '1'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-px-del-'))
}

function makePool(dir = tmp()) {
  const pool = new ProxyPool({ dataDir: dir })
  pool.stopScheduler()
  return { pool, dir }
}

function writeVm(project, id) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, status: 'stopped', schedulable: true, claude: {} }),
  )
}

function panelHarness({ project, pool, role = 'admin', userId = 'u1' }) {
  const response = { status: 0, body: null }
  const handlePanel = createPanelHandler({
    cfg: { paths: { project }, vm: { id: null } },
    requireAuth(req) {
      // Session auth: a master key would force role=admin via panelIdentity.
      req.apiKeyKind = 'panel'
      req.panelRole = role
      req.panelUser = role === 'admin' ? 'admin' : 'tenant'
      req.panelUserId = userId
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    async readBody() {
      return panelHarness._body || {}
    },
    proxyPool: pool,
  })
  return {
    response,
    async call(method, pathname, body, search = '') {
      panelHarness._body = body
      response.status = 0
      response.body = null
      const url = new URL(`http://localhost${pathname}${search}`)
      await handlePanel({ method, headers: {}, panelRole: role, panelUserId: userId }, {}, url)
      return response
    },
  }
}

test('remove refuses an in-use proxy without force and deletes with force', () => {
  const { pool } = makePool()
  pool.importLines('10.0.0.9:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-a')
  const blocked = pool.remove(id)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'proxy_in_use')
  assert.deepEqual(blocked.bound_vm_ids, ['vm-a'])
  assert.equal(pool.snapshot().proxies.length, 1)
  const removed = pool.remove(id, { force: true })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.unbound_vm_ids, ['vm-a'])
  assert.equal(pool.snapshot().proxies.length, 0)
})

test('removeMany reports per-id failures, skips duplicates, and keeps partial success', () => {
  const { pool } = makePool()
  pool.importLines('10.0.0.9:1080\n10.0.0.10:1080\n10.0.0.11:1080')
  const [a, b, c] = pool.snapshot().proxies.map((p) => p.id)
  pool.bind(b, 'vm-b')
  const result = pool.removeMany([a, a, b, 'px-missing', '', c], { force: false })
  assert.equal(result.ok, false)
  assert.equal(result.deleted.length, 2)
  assert.equal(
    result.deleted
      .map((p) => p.id)
      .sort()
      .join(),
    [a, c].sort().join(),
  )
  const errors = Object.fromEntries(result.failed.map((f) => [f.id, f.error]))
  assert.equal(errors[b], 'proxy_in_use')
  assert.equal(errors['px-missing'], 'proxy_not_found')
  assert.equal(errors[''], 'invalid_proxy_id')
  assert.equal(
    pool
      .snapshot()
      .proxies.map((p) => p.id)
      .join(),
    b,
  )
  const forced = pool.removeMany([b], { force: true })
  assert.equal(forced.ok, true)
  assert.equal(pool.snapshot().proxies.length, 0)
})

test('DELETE /api/panel/proxies/:id returns 409 when in use and deletes with force=1', async () => {
  const project = tmp()
  const { pool } = makePool(path.join(project, 'data'))
  fs.mkdirSync(path.join(project, 'data'), { recursive: true })
  writeVm(project, 'vm-a')
  pool.importLines('10.0.0.9:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-a')
  const h = panelHarness({ project, pool })
  let res = await h.call('DELETE', `/api/panel/proxies/${id}`)
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.error.code, 'proxy_in_use')
  assert.equal(pool.snapshot().proxies.length, 1)
  res = await h.call('DELETE', `/api/panel/proxies/${id}`, null, '?force=1')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(pool.snapshot().proxies.length, 0)
  const vm = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'vm-a.json'), 'utf8'))
  assert.equal(vm.proxy == null || vm.proxy?.id == null, true)
  assert.equal(vm.schedulable, false)
})

test('DELETE unknown id is 404; empty id is 400', async () => {
  const project = tmp()
  const { pool } = makePool(path.join(project, 'data'))
  const h = panelHarness({ project, pool })
  let res = await h.call('DELETE', '/api/panel/proxies/px-nope')
  assert.equal(res.status, 404)
  assert.equal(res.body.error.code, 'proxy_not_found')
})

test('POST batch-delete validates input and returns partial results', async () => {
  const project = tmp()
  const { pool } = makePool(path.join(project, 'data'))
  writeVm(project, 'vm-b')
  pool.importLines('10.0.0.9:1080\n10.0.0.10:1080')
  const [a, b] = pool.snapshot().proxies.map((p) => p.id)
  pool.bind(b, 'vm-b')
  const h = panelHarness({ project, pool })
  let res = await h.call('POST', '/api/panel/proxies/batch-delete', {})
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'invalid_ids')
  res = await h.call('POST', '/api/panel/proxies/batch-delete', { ids: [] })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'empty_ids')
  res = await h.call('POST', '/api/panel/proxies/batch-delete', { ids: [a, b, 'px-nope'] })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.deleted.length, 1)
  assert.equal(res.body.data.deleted[0].id, a)
  const failed = Object.fromEntries(res.body.data.failed.map((f) => [f.id, f.error]))
  assert.equal(failed[b], 'proxy_in_use')
  assert.equal(failed['px-nope'], 'proxy_not_found')
  assert.equal(
    pool
      .snapshot()
      .proxies.map((p) => p.id)
      .join(),
    b,
  )
  res = await h.call('POST', '/api/panel/proxies/batch-delete', { ids: [b], force: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.deleted.length, 1)
  assert.equal(pool.snapshot().proxies.length, 0)
})

test("tenant batch-delete cannot remove another user's proxy", async () => {
  const project = tmp()
  const { pool } = makePool(path.join(project, 'data'))
  pool.importLines('10.0.0.9:1080')
  const id = pool.snapshot().proxies[0].id
  pool.state.proxies[0].owner_user_id = 'other'
  pool.save()
  const h = panelHarness({ project, pool, role: 'user', userId: 'u1' })
  const res = await h.call('POST', '/api/panel/proxies/batch-delete', { ids: [id], force: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.deleted.length, 0)
  assert.equal(res.body.data.failed[0].error, 'proxy_not_found')
  assert.equal(pool.snapshot().proxies.length, 1)
})
