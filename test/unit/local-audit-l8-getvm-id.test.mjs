import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'

test('L8: getVm refuses ids that would leave the vms directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'getvm-id-'))
  try {
    fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01' }))
    fs.writeFileSync(path.join(root, 'secret.json'), JSON.stringify({ id: 'secret', token: 'x' }))
    fs.mkdirSync(path.join(root, 'vms', 'sub'))
    fs.writeFileSync(path.join(root, 'vms', 'sub', 'x.json'), JSON.stringify({ id: 'x' }))
    assert.equal(getVm(root, 'vm-01').id, 'vm-01')
    assert.equal(getVm(root, decodeURIComponent('..%2Fsecret')), null)
    assert.equal(getVm(root, '../secret'), null)
    assert.equal(getVm(root, '..\\secret'), null)
    assert.equal(getVm(root, 'sub/x'), null)
    assert.equal(getVm(root, 'vm-01\0'), null)
    assert.equal(getVm(root, ''), null)
    assert.equal(getVm(root, undefined), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
