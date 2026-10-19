/**
 * One Grok conversation stays on the account that already holds its prompt cache.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { orderGrokSessionSlots, pinGrokConversation } from '../../src/lib/pool/grok-slot-pool.mjs'
import { grokRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { StickyRouter, firstUserFingerprint } from '../../src/lib/pool/sticky-router.mjs'

function slot(id) {
  return { id, platform: 'xai', family: 'grok', has_token: true, status: 'active', grok: {} }
}

test('a busy Grok home is waited on, not replaced', () => {
  grokRuntime.reset()
  const policy = { max_concurrency: 1 }
  const held = grokRuntime.tryAcquire('vm-a', { concurrency: 1 })
  assert.ok(held)
  const ordered = orderGrokSessionSlots([slot('vm-a'), slot('vm-b')], {
    boundVmId: 'vm-a',
    sessionKey: 'conv-1',
    quotaPolicy: policy,
    roundRobinCursor: 0,
  })
  assert.equal(ordered.affinity, 'wait')
  assert.deepEqual(ordered.ids, ['vm-a'])
  assert.equal(ordered.sticky, true)
  held.release()
  grokRuntime.reset()
})

test('a free Grok home stays first', () => {
  grokRuntime.reset()
  const ordered = orderGrokSessionSlots([slot('vm-a'), slot('vm-b')], {
    boundVmId: 'vm-a',
    sessionKey: 'conv-1',
    quotaPolicy: { max_concurrency: 1 },
    roundRobinCursor: 0,
  })
  assert.equal(ordered.affinity, undefined)
  assert.equal(ordered.ids[0], 'vm-a')
  assert.equal(ordered.sticky, true)
  grokRuntime.reset()
})

test('the first claim owns the conversation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-grok-pin-'))
  const router = new StickyRouter({ dataDir: dir, config: { sticky: { enabled: true } } })
  const keys = { sessionKey: 'p:xai:conv-1', stickyKeys: ['p:xai:conv-1', 'p:xai:ch:abc'] }
  assert.equal(pinGrokConversation(router, keys, 'vm-a'), 'vm-a')
  assert.equal(pinGrokConversation(router, keys, 'vm-b'), 'vm-a')
  assert.equal(router.resolve('p:xai:ch:abc')?.vmId, 'vm-a')
})

test('Responses input_text and a later turn keep one fingerprint', () => {
  const first = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<system-reminder>Mon</system-reminder> fix the login bug' }],
      },
    ],
  }
  const later = {
    input: [
      ...first.input,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'looking' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tool result that changes' }] },
    ],
  }
  const tuesday = {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<system-reminder>Tue</system-reminder> fix the login bug' }],
      },
    ],
  }
  const fingerprint = firstUserFingerprint(first)
  assert.ok(fingerprint)
  assert.equal(firstUserFingerprint(later), fingerprint)
  assert.equal(firstUserFingerprint(tuesday), fingerprint)
})
