import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearCachePrefixSessions,
  describeCacheContinuity,
  firstHistoryDiff,
  trackCachePrefix,
} from '../../src/lib/protocol/cache-prefix.mjs'

const body = (system, ...texts) => ({
  tools: [{ name: 'Read' }],
  system: [{ type: 'text', text: system }],
  messages: texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', content: text })),
})

test('a growing conversation keeps its prefix', () => {
  clearCachePrefixSessions()
  assert.deepEqual(trackCachePrefix('s', body('p', 'u1'), 0), { turn: 1, break: null })
  assert.deepEqual(trackCachePrefix('s', body('p', 'u1', 'a1', 'u2'), 1), { turn: 2, break: null })
})

test('moving cache markers is not a history break', () => {
  clearCachePrefixSessions()
  const first = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  const second = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  trackCachePrefix('s', first, 0)
  assert.equal(trackCachePrefix('s', second, 1).break, null)
})

test('the first changed section is reported', () => {
  clearCachePrefixSessions()
  trackCachePrefix('s', body('p', 'u1', 'a1', 'u2'), 0)
  const system = trackCachePrefix('s', body('p2', 'u1', 'a1', 'u2', 'a2', 'u3'), 1).break
  assert.equal(system.section, 'system')
  assert.equal(system.kind, 'text')
  const edited = trackCachePrefix('s', body('p2', 'u1', 'edited', 'u2', 'a2', 'u3'), 2).break
  assert.equal(edited.section, 'messages')
  assert.equal(edited.index, 1)
  assert.equal(edited.kind, 'text')
  assert.equal(edited.diff.reason, 'part')
  assert.equal(edited.diff.fields.change, 'length')
  const shorter = trackCachePrefix('s', body('p2', 'u1'), 3).break
  assert.equal(shorter.section, 'messages')
  assert.equal(shorter.index, 1)
  assert.equal(shorter.kind, 'structure')
  assert.equal(shorter.diff.reason, 'missing')
})

test('an idle session past the longest TTL starts over', () => {
  clearCachePrefixSessions()
  trackCachePrefix('s', body('p', 'u1'), 0)
  assert.deepEqual(trackCachePrefix('s', body('other', 'u1'), 60 * 60_000), { turn: 1, break: null })
})

test('inbound to outbound image edits are classified without storing bytes', () => {
  const inbound = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaa'.repeat(40) } }],
      },
    ],
  }
  const outbound = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bbb'.repeat(40) } }],
      },
    ],
  }
  const imageDiff = firstHistoryDiff(inbound, outbound)
  assert.equal(imageDiff.section, 'messages')
  assert.equal(imageDiff.index, 0)
  assert.equal(imageDiff.kind, 'image')
  assert.equal(JSON.stringify(imageDiff).includes('aaa'), false)
  assert.equal(JSON.stringify(imageDiff).includes('bbb'), false)
  const summary = JSON.stringify(
    describeCacheContinuity({
      inbound,
      outbound,
      layer: 'node_object',
      ttl: '1h',
      sessionId: 'sess',
      vmId: 'vm-01',
      accountId: 'acc',
      requestId: 'req',
    }),
  )
  assert.equal(summary.includes('aaa'), false)
  assert.equal(summary.includes('bbb'), false)
  const described = describeCacheContinuity({
    inbound,
    outbound,
    layer: 'node_object',
    ttl: '1h',
    sessionId: 'sess',
    vmId: 'vm-01',
    accountId: 'acc',
    requestId: 'req',
  })
  assert.equal(described.layer, 'node_object')
  assert.equal(described.wire_observed, false)
  assert.equal(described.ttl, '1h')
  assert.equal(described.session_id, 'sess')
  assert.equal(described.vm_id, 'vm-01')
  assert.equal(described.account_id, 'acc')
})

test('structure names the changed tool_result field and does not keep its text', () => {
  clearCachePrefixSessions()
  const tool = (content) => ({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] }],
  })
  trackCachePrefix('s', tool('file contents alpha'), 0)
  const broke = trackCachePrefix('s', tool('file contents beta and more'), 1).break
  assert.equal(broke.kind, 'structure')
  assert.equal(broke.diff.reason, 'part')
  assert.equal(broke.diff.type, 'tool_result')
  assert.equal(broke.diff.fields.changed[0].key, 'content')
  assert.equal(broke.diff.fields.changed[0].change, 'length')
  const encoded = JSON.stringify(broke)
  assert.equal(encoded.includes('alpha'), false)
  assert.equal(encoded.includes('beta'), false)
})

test('an official token counter inside a tool result is labeled without rewriting it', () => {
  clearCachePrefixSessions()
  const tool = (n) => ({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: `note <total_tokens>${n} tokens left</total_tokens>` },
        ],
      },
    ],
  })
  trackCachePrefix('s', tool(100), 0)
  const broke = trackCachePrefix('s', tool(90), 1).break
  assert.equal(broke.diff.fields.change, 'counter_only')
  assert.equal(JSON.stringify(broke).includes('tokens left'), false)
})

test('extra message fields and key order are not called a block-shape change', () => {
  clearCachePrefixSessions()
  trackCachePrefix('s', { messages: [{ role: 'user', content: 'u1' }] }, 0)
  const extra = trackCachePrefix('s', { messages: [{ role: 'user', content: 'u1', extra: 1 }] }, 1).break
  assert.equal(extra.kind, 'structure')
  assert.equal(extra.diff.reason, 'message_fields')
  assert.deepEqual(extra.diff.added, ['extra'])
  const ordered = {
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'same' }] }],
  }
  const reordered = {
    messages: [{ role: 'user', content: [{ content: 'same', tool_use_id: 't1', type: 'tool_result' }] }],
  }
  clearCachePrefixSessions()
  trackCachePrefix('s', ordered, 0)
  const order = trackCachePrefix('s', reordered, 1).break
  assert.equal(order.diff.fields.key_order, true)
})

test('a counter nested in tool_result.content[] is counter_only', () => {
  clearCachePrefixSessions()
  const tool = (n) => ({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: `<total_tokens>${n} tokens left</total_tokens>` }],
          },
        ],
      },
    ],
  })
  trackCachePrefix('s', tool(100), 0)
  const broke = trackCachePrefix('s', tool(90), 1).break
  assert.equal(broke.diff.fields.change, 'counter_only')
  assert.equal(broke.diff.fields.changed, undefined)
  assert.equal(JSON.stringify(broke).includes('tokens left'), false)
})

test('a tools difference does not hide a message difference', () => {
  const inbound = {
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'u1' }],
  }
  const outbound = {
    tools: [{ name: 'Read', input_schema: { type: 'object', required: ['path'] } }],
    messages: [{ role: 'user', content: 'u1 changed' }],
  }
  const diff = firstHistoryDiff(inbound, outbound)
  assert.equal(diff.section, 'tools')
  assert.deepEqual(
    diff.sections.map((item) => item.section),
    ['tools', 'messages'],
  )
  assert.equal(diff.sections[1].index, 0)
  assert.equal(diff.sections[1].diff.reason, 'part')
  assert.equal(JSON.stringify(diff).includes('u1 changed'), false)
})

test('a sampled counter plus an unsampled tool body change is not counter_only', () => {
  clearCachePrefixSessions()
  const tool = (n, tail) => ({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: `<total_tokens>${n} tokens left</total_tokens>` },
              { type: 'text', text: 'b' },
              { type: 'text', text: 'c' },
              { type: 'text', text: 'd' },
              { type: 'text', text: 'e' },
              { type: 'text', text: 'f' },
              { type: 'text', text: tail },
            ],
          },
        ],
      },
    ],
  })
  trackCachePrefix('s', tool(100, 'alpha'), 0)
  const broke = trackCachePrefix('s', tool(90, 'beta changed'), 1).break
  const encoded = JSON.stringify(broke)
  assert.notEqual(broke.diff.fields.change, 'counter_only')
  assert.equal(encoded.includes('"change":"unknown"'), true)
  assert.equal(encoded.includes('"capped":true'), true)
  assert.equal(JSON.stringify(broke).includes('beta'), false)
})

test('a depth-capped object difference stays unknown instead of disappearing', () => {
  clearCachePrefixSessions()
  const tool = (note) => ({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'same', source: { meta: { note } } }],
          },
        ],
      },
    ],
  })
  trackCachePrefix('s', tool('alpha'), 0)
  const broke = trackCachePrefix('s', tool('beta'), 1).break
  assert.notEqual(broke.diff.fields.change, 'counter_only')
  assert.equal(JSON.stringify(broke).includes('"change":"unknown"'), true)
  assert.equal(JSON.stringify(broke).includes('"capped":true'), true)
  assert.equal(JSON.stringify(broke).includes('alpha'), false)
  assert.equal(JSON.stringify(broke).includes('beta'), false)
})
