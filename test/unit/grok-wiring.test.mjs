import test from 'node:test'
import assert from 'node:assert/strict'
import { keyAllowsVm, normalizeGroupType, normalizeKeyScope, vmGroupType } from '../../src/lib/admin/key-scope.mjs'
import { platformOfModel } from '../../src/lib/admin/price-catalog.mjs'

const grok = { id: 'vm-g', platform: 'xai', family: 'grok' }
const claude = { id: 'vm-c', platform: 'anthropic' }

test('a Grok slot is group xai, not Claude', () => {
  assert.equal(vmGroupType(grok), 'xai')
  assert.equal(vmGroupType(claude), 'anthropic')
  assert.equal(normalizeGroupType('grok'), 'xai')
  const scope = normalizeKeyScope({ group_type: 'xai', allowed_vms: ['vm-g'] })
  assert.equal(keyAllowsVm(scope, grok), true)
  assert.equal(keyAllowsVm(scope, claude), false)
  assert.equal(keyAllowsVm({ group_type: 'anthropic', allowed_vms: ['vm-g'] }, grok), false)
})

test('grok model ids price as xai and stay out of the Claude health cache', () => {
  assert.equal(platformOfModel('grok-3'), 'xai')
  assert.equal(platformOfModel('gpt-5.4'), 'openai')
})
