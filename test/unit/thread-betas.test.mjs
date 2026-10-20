import test from 'node:test'
import assert from 'node:assert/strict'
import { pinThreadBetas, rememberThreadTurn, resetThreadBetasForTest } from '../../src/lib/protocol/thread-betas.mjs'

const MODEL = 'claude-opus-5-5'
const OUTPUT_CONFIG = 'mid-conversation-output-config-2026-07-01'
const CREATED = ['oauth-2025-04-20', 'message-threads-2026-08-12', OUTPUT_CONFIG]
const create = { model: MODEL, thread: { type: 'create' }, messages: [] }

function resume(from, model = MODEL) {
  return { model, thread: { type: 'continue', previous_message_id: from }, messages: [] }
}

test('requests outside a thread keep their betas', () => {
  resetThreadBetasForTest()
  const betas = ['oauth-2025-04-20']
  assert.deepEqual(pinThreadBetas({ model: MODEL, messages: [] }, betas), { betas, turn: null })
})

test('a continue turn carries forward the create turn betas', () => {
  resetThreadBetasForTest()
  const created = pinThreadBetas(create, CREATED)
  rememberThreadTurn('msg_create', created.turn)
  const computed = CREATED.filter((token) => token !== OUTPUT_CONFIG)
  const resumed = pinThreadBetas(resume('msg_create'), computed)
  assert.deepEqual(resumed.betas, CREATED)
  assert.equal(resumed.turn.pin, 'pinned')
  assert.deepEqual(resumed.turn.added, [OUTPUT_CONFIG])
  assert.deepEqual(resumed.turn.extra, [])
  rememberThreadTurn('msg_turn2', resumed.turn)
  assert.deepEqual(pinThreadBetas(resume('msg_turn2'), computed).betas, CREATED)
})

test('newly derived betas remain present on continue turns', () => {
  resetThreadBetasForTest()
  rememberThreadTurn('msg_create', pinThreadBetas(create, CREATED).turn)
  const clearAt = 'mid-conversation-system-clear-at-2026-08-21'
  const resumed = pinThreadBetas(resume('msg_create'), [...CREATED, clearAt])
  assert.deepEqual(resumed.betas, [...CREATED, clearAt])
  assert.deepEqual(resumed.turn.extra, [clearAt])
})

test('unknown, expired and changed-model turns use their computed betas', () => {
  resetThreadBetasForTest()
  const computed = ['oauth-2025-04-20']
  assert.equal(pinThreadBetas(resume('msg_unknown'), computed).turn.pin, 'miss')
  rememberThreadTurn('msg_create', pinThreadBetas(create, CREATED).turn, { now: 0 })
  const expired = pinThreadBetas(resume('msg_create'), computed, { now: 24 * 60 * 60 * 1000 })
  assert.equal(expired.turn.pin, 'miss')
  assert.deepEqual(expired.betas, computed)
  rememberThreadTurn('msg_create', pinThreadBetas(create, CREATED).turn)
  const switched = pinThreadBetas(resume('msg_create', 'claude-sonnet-5-5'), computed)
  assert.equal(switched.turn.pin, 'model_changed')
  assert.deepEqual(switched.betas, computed)
})

test('pins stay bounded to the newest 10000 message ids', () => {
  resetThreadBetasForTest()
  const { turn } = pinThreadBetas(create, CREATED)
  for (let index = 0; index <= 10_000; index++) rememberThreadTurn(`msg_${index}`, turn)
  assert.equal(pinThreadBetas(resume('msg_0'), CREATED).turn.pin, 'miss')
  assert.equal(pinThreadBetas(resume('msg_10000'), CREATED).turn.pin, 'pinned')
})
