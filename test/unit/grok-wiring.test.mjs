import test from 'node:test'
import assert from 'node:assert/strict'
import { keyAllowsVm, normalizeGroupType, normalizeKeyScope, vmGroupType } from '../../src/lib/admin/key-scope.mjs'
import { platformOfModel } from '../../src/lib/admin/price-catalog.mjs'
import { seedGrokPolicy } from '../../src/lib/protocol/grok-model-policy.mjs'

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

test('published Grok models keep their context window instead of the old 128k default', () => {
  const models = seedGrokPolicy().models
  assert.equal(models['grok-4.7'].capabilities.context_window, 500_000)
  assert.equal(models['grok-4.7'].capabilities.supports_effort, true)
  assert.equal(models['grok-4.3'].capabilities.context_window, 1_000_000)
  assert.equal(models['grok-4.3'].capabilities.supports_1m, true)
  assert.equal(models['grok-build-0.1'].capabilities.context_window, 256_000)
})
