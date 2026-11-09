import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { api, startGateway } from '../harness.mjs'

test('credential/clear drops the account and keeps the slot（清凭证留槽位）', async () => {
  const gw = await startGateway()
  try {
    const slotDir = path.join(gw.project, 'vms', 'vm-sim-01')
    const vmPath = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const seeded = [
      path.join(slotDir, 'codex-credentials.json'),
      path.join(slotDir, 'grok-credentials.json'),
      path.join(slotDir, 'cli-home', '.claude', 'credentials.json'),
    ]
    for (const file of seeded) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ access_token: 'stale-seed-token' }))
    }
    const before = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    fs.writeFileSync(vmPath, JSON.stringify({ ...before, grok: { email: 'x@example.com', has_access: true } }))
    assert.equal(before.claude.access_token, 'sk-ant-oat01-FAKE-SEED')
    assert.equal(before.schedulable, true)

    const res = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/credential/clear', { body: {} })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.data.cleared.vm_id, 'vm-sim-01')
    for (const file of seeded) {
      assert.equal(fs.existsSync(file), false, `${file} should be removed`)
      assert.ok(
        res.json.data.cleared.files.some((entry) => entry.endsWith(path.basename(file))),
        `cleared.files should report ${path.basename(file)}`,
      )
    }

    // 槽位记录和容器本身不动，只是变成「没有凭证」的不可调度槽
    assert.equal(fs.existsSync(vmPath), true)
    const after = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    assert.equal(after.id, 'vm-sim-01')
    assert.equal(after.status, before.status)
    assert.equal(after.schedulable, false)
    assert.equal(after.schedule_disabled_reason, 'no_credential')
    assert.equal(after.email, null)
    assert.equal(after.account_uuid, null)
    assert.deepEqual(after.claude, {})
    assert.deepEqual(after.grok, {})

    assert.equal(res.json.data.vm.id, 'vm-sim-01')
    assert.equal(res.json.data.vm.email, null)
    assert.equal(res.json.data.vm.has_token, false)
  } finally {
    await gw.stop()
  }
})

test('credential/clear on an unknown slot → 404 vm_not_found', async () => {
  const gw = await startGateway()
  try {
    const res = await api(gw, 'POST', '/api/panel/vms/vm-nope/credential/clear', { body: {} })
    assert.equal(res.status, 404, res.text)
    assert.equal(res.json.error.code, 'vm_not_found')
  } finally {
    await gw.stop()
  }
})
