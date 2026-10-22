import test from 'node:test'
import assert from 'node:assert/strict'
import { runGrokSlotHop } from '../../src/lib/protocol/handle-grok.mjs'

function hopOps(writes) {
  return {
    hostProxyUrlForVm: () => 'socks5h://203.0.113.9:1080',
    writeGrokKernelConfig: () => {
      writes.push(1)
      return { agentId: 'agent-1' }
    },
    callGrokKernel: async () => ({
      statusCode: 200,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{"ok":true}')
      },
    }),
  }
}

const hop = (ops, kernelConfig) =>
  runGrokSlotHop({
    projectRoot: '/nonexistent',
    vm: { id: 'vm-g', proxy: { id: 'px-1', url: 'socks5h://203.0.113.9:1080' } },
    routing: {},
    outbound: { path: '/v1/chat/completions', body: { model: 'grok-4' } },
    stream: false,
    ops,
    kernelConfig,
  })

test('a hop reuses the kernel config its caller already wrote', async () => {
  const writes = []
  const result = await hop(hopOps(writes), { agentId: 'agent-1' })
  assert.equal(result.ok, true)
  assert.equal(writes.length, 0)
})

test('a hop without one writes the kernel config itself', async () => {
  const writes = []
  assert.equal((await hop(hopOps(writes), null)).ok, true)
  assert.equal(writes.length, 1)
})

test('caller identity fields never reach xAI', async () => {
  const { buildGrokOutbound } = await import('../../src/lib/protocol/handle-grok.mjs')
  const body = {
    model: 'grok-4.3',
    user: 'tenant-42@corp',
    safety_identifier: 'sid-9',
    prompt_cache_key: 'pck',
    metadata: { user_id: 'u', team: 'acme' },
    client_metadata: { a: 1 },
    temperature: 0.2,
    messages: [{ role: 'user', content: 'hi' }],
  }
  for (const [protocol, mode] of [
    ['openai.chat', 'native'],
    ['openai.responses', 'native'],
    ['anthropic.messages', 'native'],
    ['anthropic.messages', 'convert'],
  ]) {
    const out = buildGrokOutbound(protocol, body, mode, { stream: false })
    for (const key of ['user', 'safety_identifier', 'prompt_cache_key', 'metadata', 'client_metadata']) {
      assert.equal(key in out.body, false, `${protocol}/${mode} kept ${key}`)
    }
  }
  assert.equal(buildGrokOutbound('openai.chat', body, 'native', { stream: false }).body.temperature, 0.2)
})
