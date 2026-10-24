import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { isLocalEgressProxy } from '../../src/lib/vm/egress.mjs'
import { powerOnSlot, reviveDownSlots } from '../../src/lib/vm/slot-recovery.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'

function makePool(t) {
  const pool = new ProxyPool({ db: openDatabase({ dbPath: ':memory:' }) })
  pool.updateConfig({ enabled: false })
  t.after(() => {
    pool.stopScheduler()
    closeDatabase()
  })
  return pool
}

test('import rejects a SOCKS host named local in any case', (t) => {
  const pool = makePool(t)
  const result = pool.importLines('Local:1080\nlocal:1080')
  assert.equal(result.added, 0)
  assert.equal(result.skip_details.length, 2)
  assert.ok(result.skip_details.every((row) => row.reason === 'proxy_host_blocked'))
  assert.equal(isLocalEgressProxy({ host: 'LOCAL', port: 1080 }), false)
  assert.equal(isLocalEgressProxy({ scheme: 'local' }), true)
})

test('tenant power-on and watchdog revive do not bind a platform proxy', async (t) => {
  const pool = makePool(t)
  pool.ensureLocal()
  pool.importLines('203.0.113.10:1080')
  const owned = pool.importLines('203.0.113.20:1080', { ownerUserId: 'user-a' })
  assert.equal(owned.added, 1, JSON.stringify(owned.skip_details))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-boot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const id = 'vm-tenant'
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      status: 'stopped',
      owner_user_id: 'user-a',
      origin: 'user_created',
      proxy: { id: 'px-local', scheme: 'local', host: 'local' },
    }),
  )
  const boot = {
    projectRoot: root,
    proxyPool: pool,
    fillTimezone: async () => {},
    ops: { startSlotReady: async () => ({ ok: true, runtime: { type: 'docker' } }) },
  }
  const started = await powerOnSlot({ ...boot, id })
  assert.equal(started.ok, true, started.error || started.code)
  const bound = pool.getProxyForVm(id)
  assert.equal(bound.owner_user_id, 'user-a')
  assert.equal(bound.host, '203.0.113.20')
  assert.equal(isLocalEgressProxy(bound), false)
  assert.equal(getVm(root, id).proxy.host, '203.0.113.20')

  pool.unbindVm(id)
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({ id, status: 'running', owner_user_id: 'user-a', origin: 'user_created' }),
  )
  const revived = await reviveDownSlots({
    vms: [{ id, status: 'running', owner_user_id: 'user-a', origin: 'user_created' }],
    inspect: async () => ({ running: false, exists: false, status: 'exited' }),
    powerOn: (vmId) => powerOnSlot({ ...boot, id: vmId }),
  })
  assert.equal(revived[0]?.ok, true, JSON.stringify(revived))
  assert.equal(pool.getProxyForVm(id).host, '203.0.113.20')

  pool.unbindVm(id)
  pool.remove(owned.items[0].id)
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({ id, status: 'stopped', owner_user_id: 'user-a', origin: 'user_created' }),
  )
  const denied = await powerOnSlot({ ...boot, id })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'proxy_required')
  assert.equal(pool.getProxyForVm(id), null)
})

test('admin-assigned slots keep a bound platform proxy', async (t) => {
  const pool = makePool(t)
  const plat = pool.importLines('203.0.113.10:1080')
  pool.importLines('203.0.113.30:1080', { ownerUserId: 'user-b' })
  assert.equal(plat.added, 1, JSON.stringify(plat.skip_details))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-aa-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const id = 'vm-assigned'
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  pool.bind(plat.items[0].id, id)
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      status: 'stopped',
      owner_user_id: 'user-a',
      origin: 'admin_assigned',
      proxy: { id: plat.items[0].id, scheme: 'socks5', host: '203.0.113.10', port: 1080 },
    }),
  )
  const started = await powerOnSlot({
    projectRoot: root,
    id,
    proxyPool: pool,
    fillTimezone: async () => {},
    ops: { startSlotReady: async () => ({ ok: true, runtime: { type: 'docker' } }) },
  })
  assert.equal(started.ok, true, started.error || started.code)
  assert.equal(pool.getProxyForVm(id)?.host, '203.0.113.10')

  pool.unbindVm(id)
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({ id, status: 'stopped', owner_user_id: 'user-a', origin: 'admin_assigned' }),
  )
  const allocated = await powerOnSlot({
    projectRoot: root,
    id,
    proxyPool: pool,
    fillTimezone: async () => {},
    ops: { startSlotReady: async () => ({ ok: true, runtime: { type: 'docker' } }) },
  })
  assert.equal(allocated.ok, true, allocated.error || allocated.code)
  assert.equal(pool.getProxyForVm(id)?.host, '203.0.113.10')
  assert.notEqual(pool.getProxyForVm(id)?.owner_user_id, 'user-b')
})
