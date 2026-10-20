import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  loadGrokModelPolicy,
  resetGrokModelPolicyForTests,
  saveGrokModelPolicy,
  syncGrokIdsIntoPolicy,
} from '../../src/lib/protocol/grok-model-policy.mjs'

function withDb(fn) {
  openDatabase({ dbPath: ':memory:' })
  resetGrokModelPolicyForTests()
  try {
    return fn(new SettingsRepo())
  } finally {
    resetGrokModelPolicyForTests()
    closeDatabase()
  }
}

test('a panel save keeps a Grok context window of 200k and the output limits', () => {
  withDb((repo) => {
    const saved = saveGrokModelPolicy({
      models: {
        'grok-4.7': {
          display_name: 'Grok 4.7',
          capabilities: { context_window: 200_000, supports_effort: true },
          params: { max_tokens_default: 32_000, max_tokens_cap: 64_000 },
          aliases: ['grok'],
        },
      },
    })
    const row = saved.models['grok-4.7']
    assert.equal(row.capabilities.context_window, 200_000)
    assert.equal(row.capabilities.context_window_custom, true)
    assert.equal(row.capabilities.supports_1m, false)
    assert.equal(row.params.max_tokens_default, 32_000)
    assert.equal(row.params.max_tokens_cap, 64_000)
    assert.deepEqual(row.aliases, ['grok'])

    resetGrokModelPolicyForTests()
    const loaded = loadGrokModelPolicy()
    assert.equal(loaded.models['grok-4.7'].capabilities.context_window, 200_000)
    assert.equal(loaded.models['grok-4.7'].params.max_tokens_default, 32_000)
    assert.equal(repo.get('grok_model_policy').models['grok-4.7'].capabilities.context_window, 200_000)

    syncGrokIdsIntoPolicy(['grok-4.7'])
    assert.equal(loadGrokModelPolicy().models['grok-4.7'].capabilities.context_window, 200_000)
  })
})

test('an old unmarked 128k Grok window is still upgraded to the published window', () => {
  withDb((repo) => {
    repo.set('grok_model_policy', {
      source: 'panel',
      models: {
        'grok-4.7': {
          display_name: 'Grok 4.7',
          capabilities: { context_window: 131_072 },
          params: { max_tokens_default: 16_384, max_tokens_cap: 128_000 },
        },
      },
    })
    const loaded = loadGrokModelPolicy()
    assert.equal(loaded.models['grok-4.7'].capabilities.context_window, 500_000)
    assert.equal(loaded.models['grok-4.7'].capabilities.context_window_custom, undefined)
    assert.equal(repo.get('grok_model_policy').models['grok-4.7'].capabilities.context_window, 500_000)
  })
})

test('saving the published window does not mark it as a custom override', () => {
  withDb(() => {
    const saved = saveGrokModelPolicy({
      models: {
        'grok-4.3': {
          capabilities: { context_window: 1_000_000 },
          params: { max_tokens_default: 8_192, max_tokens_cap: 32_000 },
        },
      },
    })
    const row = saved.models['grok-4.3']
    assert.equal(row.capabilities.context_window, 1_000_000)
    assert.equal(row.capabilities.supports_1m, true)
    assert.equal(row.capabilities.context_window_custom, undefined)
    assert.equal(row.params.max_tokens_cap, 32_000)
  })
})
