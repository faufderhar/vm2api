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

test('a token endpoint hiccup is a short 503 hold, a dead refresh token is a 401', async () => {
  const { grokKernelErrorStatus, grokUpstreamCall } = await import('../../src/lib/protocol/handle-grok.mjs')
  const { codexFailureHold } = await import('../../src/lib/protocol/handle-codex.mjs')
  const kernel = (code) => async () => ({
    statusCode: code === 'refresh_rejected' ? 401 : 503,
    kernelError: true,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ error: { code, message: 'x' } }))
    },
  })
  const call = (code) =>
    grokUpstreamCall({
      projectRoot: '/x',
      vmId: 'vm',
      envelope: {},
      stream: false,
      ops: { callGrokKernel: kernel(code) },
    })
  const hiccup = await call('refresh_failed')
  assert.equal(hiccup.status, 503)
  assert.equal(hiccup.body.error.code, 'refresh_failed')
  const now = 1_000_000
  assert.equal(codexFailureHold(hiccup, now).until, now + 30_000)
  const dead = await call('refresh_rejected')
  assert.equal(dead.status, 401)
  assert.equal(codexFailureHold(dead, now).until, now + 5 * 60_000)
  // Codes are fixed: anything unknown is retryable, not a login problem.
  assert.equal(grokKernelErrorStatus('unauthorized'), 503)
  assert.equal(grokKernelErrorStatus('grok_token_expired'), 401)
})

test('a slot credential failure reaches the caller as 503, not as a 401 about their key', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { handleGrokProtocol } = await import('../../src/lib/protocol/handle-grok.mjs')
  const { upsertGrokAccount } = await import('../../src/lib/vm/grok-slot.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-hop-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-g'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-g.json'),
    JSON.stringify({
      id: 'vm-g',
      platform: 'xai',
      family: 'grok',
      status: 'running',
      proxy: { id: 'px-local', scheme: 'local' },
      grok: {},
    }),
  )
  upsertGrokAccount(root, 'vm-g', { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3_600_000 })
  const sent = {}
  const res = {
    headersSent: false,
    setHeader() {},
    once() {},
    off() {},
  }
  const json = (_res, status, body) => {
    sent.status = status
    sent.body = body
  }
  const body = { model: 'grok-4.3', messages: [{ role: 'user', content: 'hi' }] }
  await handleGrokProtocol({
    req: { headers: {}, once() {}, off() {} },
    res,
    protocol: 'openai.chat',
    ctx: { body, path: '/v1/chat/completions' },
    inbound: body,
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json,
    writeSSEHeaders() {},
    routing: { grok: { enabled: true }, failover: { max_attempts: 1 } },
    projectRoot: root,
    ops: {
      writeGrokKernelConfig: () => ({ agentId: 'a' }),
      callGrokKernel: async () => ({
        statusCode: 401,
        kernelError: true,
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ error: { code: 'refresh_rejected' } }))
        },
      }),
    },
  })
  assert.equal(sent.status, 503)
  assert.equal(sent.body.error.code, 'refresh_rejected')
})

test('a prefixed model goes upstream bare; a model the panel turned off is refused before any slot', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { handleGrokProtocol } = await import('../../src/lib/protocol/handle-grok.mjs')
  const { upsertGrokAccount } = await import('../../src/lib/vm/grok-slot.mjs')
  const { saveGrokModelPolicy, resetGrokModelPolicyForTests } = await import(
    '../../src/lib/protocol/grok-model-policy.mjs'
  )
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  openDatabase({ dbPath: ':memory:' })
  resetGrokModelPolicyForTests()
  saveGrokModelPolicy({ models: { 'grok-4.3': { enabled: true }, 'grok-4.5': { enabled: false } } })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-hop-'))
  t.after(() => {
    resetGrokModelPolicyForTests()
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'vms', 'vm-g2'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-g2.json'),
    JSON.stringify({
      id: 'vm-g2',
      platform: 'xai',
      family: 'grok',
      status: 'running',
      proxy: { id: 'px-local', scheme: 'local' },
      grok: {},
    }),
  )
  upsertGrokAccount(root, 'vm-g2', { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3_600_000 })
  const envelopes = []
  const run = async (model) => {
    const sent = {}
    const body = { model, messages: [{ role: 'user', content: 'hi' }] }
    const logBag = {}
    await handleGrokProtocol({
      req: { headers: {}, once() {}, off() {} },
      res: { headersSent: false, setHeader() {}, once() {}, off() {} },
      protocol: 'openai.chat',
      ctx: { body, path: '/v1/chat/completions' },
      inbound: body,
      logBag,
      stats: { errors: 0, requests: 0, by_route: {} },
      json: (_res, status, payload) => Object.assign(sent, { status, payload }),
      writeSSEHeaders() {},
      routing: { grok: { enabled: true } },
      projectRoot: root,
      body,
      ops: {
        writeGrokKernelConfig: () => ({ agentId: 'a' }),
        callGrokKernel: async ({ envelope }) => {
          envelopes.push(envelope)
          return {
            statusCode: 200,
            headers: {},
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(
                JSON.stringify({ id: 'c', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
              )
            },
          }
        },
      },
    })
    return { ...sent, logBag }
  }
  const ok = await run('xai/grok-4.3')
  assert.equal(ok.status, 200)
  assert.equal(envelopes[0].body.model, 'grok-4.3')
  assert.equal(envelopes[0].model_id, 'grok-4.3')
  assert.equal(ok.logBag.upstream_model, 'grok-4.3')
  // No login email on this slot: the account column falls back to the slot id.
  assert.equal(ok.logBag.vm_id, 'vm-g2')
  assert.equal(ok.logBag.account_id, 'vm-g2')
  assert.equal(ok.logBag.final_account_id, 'vm-g2')
  const off = await run('grok-4.5')
  assert.equal(off.status, 400)
  assert.equal(off.payload.error.code, 'model_disabled')
  assert.equal(envelopes.length, 1)
})

test('upstream always streams; a non-stream caller gets the stream folded back', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { handleGrokProtocol } = await import('../../src/lib/protocol/handle-grok.mjs')
  const { upsertGrokAccount } = await import('../../src/lib/vm/grok-slot.mjs')
  const { grokAgentUuid } = await import('../../src/lib/protocol/grok-client.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-hop-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-g3'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-g3.json'),
    JSON.stringify({
      id: 'vm-g3',
      platform: 'xai',
      family: 'grok',
      status: 'running',
      proxy: { id: 'px-local', scheme: 'local' },
      grok: {},
    }),
  )
  upsertGrokAccount(root, 'vm-g3', { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3_600_000 })
  const sse = {
    'openai.chat': [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"grok-4.3-served","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
      '',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      '',
      'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ],
    'openai.responses': [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hi","sequence_number":1}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","sequence_number":2,"response":{"id":"r1","object":"response","status":"completed","model":"grok-4.3-served","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":3,"output_tokens":1,"output_tokens_details":{"reasoning_tokens":1}}}}',
      '',
    ],
  }
  const envelopes = []
  const run = async (protocol, body, ctxPath) => {
    const sent = {}
    const logBag = {}
    sent.logBag = logBag
    await handleGrokProtocol({
      req: { headers: {}, once() {}, off() {} },
      res: { headersSent: false, setHeader() {}, once() {}, off() {} },
      protocol,
      ctx: { body, path: ctxPath },
      inbound: body,
      logBag,
      stats: { errors: 0, requests: 0, by_route: {} },
      json: (_res, status, payload) => Object.assign(sent, { status, payload }),
      writeSSEHeaders() {},
      routing: { grok: { enabled: true } },
      projectRoot: root,
      body,
      ops: {
        writeGrokKernelConfig: () => ({ agentId: 'ab'.repeat(32) }),
        callGrokKernel: async ({ envelope }) => {
          envelopes.push(envelope)
          return {
            statusCode: 200,
            headers: {},
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(sse[protocol].join('\n') + '\n')
            },
          }
        },
      },
    })
    return sent
  }
  const chat = await run(
    'openai.chat',
    {
      model: 'grok-4.3',
      stream: false,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    },
    '/v1/chat/completions',
  )
  assert.equal(chat.status, 200)
  assert.equal(chat.payload.object, 'chat.completion')
  assert.equal(chat.payload.choices[0].message.content, 'Hello')
  assert.equal(chat.payload.choices[0].finish_reason, 'stop')
  assert.equal(chat.payload.usage.total_tokens, 5)
  // The log keeps what was asked for and what xAI says served it apart.
  assert.equal(chat.logBag.upstream_model, 'grok-4.3-served')
  const sentChat = envelopes[0]
  assert.equal(sentChat.body.stream, true)
  assert.equal(sentChat.body.stream_options.include_usage, true)
  assert.equal(sentChat.body.prompt_cache_key, undefined, 'chat completions keep no prompt_cache_key')
  assert.equal(sentChat.turn_idx, '2')
  assert.equal(sentChat.agent_id, grokAgentUuid('ab'.repeat(32)))
  assert.match(sentChat.conv_group_id, /^[0-9a-f-]{36}$/)

  const responses = await run(
    'openai.responses',
    { model: 'grok-4.3', stream: false, input: 'hi', prompt_cache_key: 'caller-key' },
    '/v1/responses',
  )
  assert.equal(responses.status, 200)
  assert.equal(responses.payload.id, 'r1')
  assert.equal(responses.logBag.upstream_model, 'grok-4.3-served')
  assert.equal(responses.logBag.reasoning_tokens, 1)
  assert.equal(responses.payload.output[0].content[0].text, 'Hi')
  const sentResponses = envelopes[1]
  assert.equal(sentResponses.body.stream, true)
  assert.equal(sentResponses.body.prompt_cache_key, sentResponses.session_id)
  assert.notEqual(sentResponses.body.prompt_cache_key, 'caller-key')
  assert.equal(sentResponses.turn_idx, '1')
})

test('the request log names the xAI login a Grok hop used', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { grokLogAccountId } = await import('../../src/lib/protocol/handle-grok.mjs')
  const { upsertGrokAccount } = await import('../../src/lib/vm/grok-slot.mjs')
  const { toUsageLogRow } = await import('../../src/lib/db/repos/usage-logs-view.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-log-account-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-g3', platform: 'xai', grok: {} }
  assert.equal(grokLogAccountId(root, vm), 'vm-g3')
  assert.equal(grokLogAccountId(root, { ...vm, grok: { account_id: 'xai-acct-1' } }), 'xai-acct-1')
  assert.equal(
    grokLogAccountId(root, { ...vm, grok: { email: 'bag@example.com', account_id: 'x' } }),
    'bag@example.com',
  )
  upsertGrokAccount(root, 'vm-g3', { access_token: 'at', refresh_token: 'rt', email: 'login@example.com' })
  assert.equal(grokLogAccountId(root, { ...vm, grok: { email: 'stale@example.com' } }), 'login@example.com')
  assert.equal(grokLogAccountId(null, null), null)

  const names = { users: new Map(), keys: new Map(), vms: new Map(), accounts: new Map() }
  const row = toUsageLogRow(
    {
      id: 1,
      created_at: '2026-10-25T00:00:00Z',
      vm_id: 'vm-g3',
      account_id: 'login@example.com',
      final_account_id: 'login@example.com',
    },
    names,
  )
  assert.equal(row.providerName, 'login@example.com')
  assert.equal(row.accountId, 'login@example.com')
})
