import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'

function claudePick() {
  return {
    ok: true,
    endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
    key: { id: 'key', api_key: 'fixture' },
    upstream_model: 'claude-haiku-4-5',
  }
}

function openaiPick() {
  return {
    ok: true,
    endpoint: { id: 'ep', kind: 'openai', protocol: 'openai', base_url: 'https://fixture.invalid' },
    key: { id: 'key', api_key: 'fixture' },
    upstream_model: 'gpt-5.4',
  }
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`
}

const usageEvents = [
  sse({
    type: 'message_start',
    message: {
      id: 'msg_api',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [],
      usage: { input_tokens: 21, output_tokens: 1, cache_read_input_tokens: 5 },
    },
  }),
  sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
  sse({ type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 6 } }),
].join('')

async function withKernel(handler, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-bill-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const kernel = http.createServer(handler)
  await new Promise((resolve) => kernel.listen(socket, resolve))
  try {
    return await run(root)
  } finally {
    kernel.closeAllConnections?.()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function downstream() {
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks: [],
    write(chunk) {
      this.chunks.push(String(chunk))
    },
    end() {
      this.writableEnded = true
    },
  }
  return res
}

test('API Anthropic stream accumulates message_start and message_delta usage', async () => {
  await withKernel(
    (req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`${usageEvents}${sse({ type: 'message_stop' })}`)
      })
    },
    async (root) => {
      const res = downstream()
      const result = await runApiInference({
        cfg: { paths: { data: root } },
        res,
        protocol: 'anthropic.messages',
        clientStream: true,
        deliveryMode: 'verified',
        convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
        inbound: {},
        converters: {
          writeSSEHeaders() {
            res.headersSent = true
          },
        },
        scheduler: { pick: claudePick },
      })
      assert.equal(result.ok, true)
      assert.equal(result.terminalState, 'verified')
      assert.equal(result.usage.input_tokens, 21)
      assert.equal(result.usage.output_tokens, 6)
      assert.equal(result.usage.cache_read_input_tokens, 5)
    },
  )
})

test('API Anthropic stream bills an incomplete hop that already reported usage', async () => {
  const charges = []
  const logged = []
  await withKernel(
    (req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(usageEvents)
      })
    },
    async (root) => {
      const routingFile = path.join(root, 'routing.json')
      fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero' } }))
      const response = {
        ...downstream(),
        on(event, fn) {
          if (event === 'finish') response.finish = fn
        },
        once() {},
        off() {},
      }
      const handler = createHandleProtocol({
        json: (_res, status, body) => {
          response.status = status
          response.body = body
          return body
        },
        writeSSEHeaders() {
          response.headersSent = true
        },
        readBody: async () => ({
          model: 'claude-haiku-4-5',
          stream: true,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hello' }],
        }),
        requireAuth: () => true,
        cfg: {
          rewrite: { enabled: false },
          intercept: { rules: [] },
          distill: { enabled: false },
          limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
          paths: { data: root },
        },
        requestLog: {
          start: () => ({ request_id: 'api-stream-bill' }),
          finish: (_ctx, row) => logged.push(row),
        },
        stickyRouter: {},
        accountQuota: {},
        apiKeyStore: {
          acquire: () => ({ ok: true }),
          release() {},
          recordUsage: (_key, usage, opts) => charges.push({ usage, opts }),
        },
        apiScheduler: { pick: claudePick },
        apiEndpointStore: {},
        stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
        routingConfigPath: routingFile,
        routingConfig: { compatibility: { persona_preset: 'zero' }, failover: {} },
        groupsRepo: { rateMultiplier: () => 1 },
      })
      const req = {
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer sk-vm-api', 'user-agent': 'test-client' },
        apiKeyKind: 'managed',
        apiKeyRecord: { id: 'key-1', category: 'api', group_id: 1 },
        once() {},
        off() {},
      }
      await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
      response.finish?.()
      assert.equal(charges.length, 1)
      assert.equal(charges[0].usage.input_tokens, 21)
      assert.equal(charges[0].usage.output_tokens, 6)
      assert.equal(logged[0].final_state, 'incomplete')
      assert.equal(logged[0].usage.input_tokens, 21)
    },
  )
})

test('API Anthropic stream interrupt keeps usage and writes an error event', async () => {
  await withKernel(
    (req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(usageEvents)
        setTimeout(() => res.destroy(), 20)
      })
    },
    async (root) => {
      const res = downstream()
      const result = await runApiInference({
        cfg: { paths: { data: root } },
        res,
        protocol: 'anthropic.messages',
        clientStream: true,
        deliveryMode: 'verified',
        convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
        inbound: {},
        converters: {
          writeSSEHeaders() {
            res.headersSent = true
          },
        },
        scheduler: { pick: claudePick },
      })
      assert.equal(result.ok, false)
      assert.equal(result.terminalState, 'incomplete')
      assert.equal(result.usage.input_tokens, 21)
      assert.equal(result.usage.output_tokens, 6)
      assert.match(res.chunks.join(''), /upstream_stream_interrupted|event: error/)
    },
  )
})

test('API Anthropic stream client abort is cancelled and keeps usage', async () => {
  let release
  const ready = new Promise((resolve) => {
    release = resolve
  })
  await withKernel(
    (req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(usageEvents)
        release()
      })
    },
    async (root) => {
      const controller = new AbortController()
      const res = downstream()
      const pending = runApiInference({
        cfg: { paths: { data: root } },
        res,
        protocol: 'anthropic.messages',
        clientStream: true,
        deliveryMode: 'verified',
        signal: controller.signal,
        convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
        inbound: {},
        converters: {
          writeSSEHeaders() {
            res.headersSent = true
          },
        },
        scheduler: { pick: claudePick },
      })
      await ready
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
      const result = await pending
      assert.equal(result.terminalState, 'cancelled')
      assert.equal(result.body.error.code, 'client_cancelled')
      assert.equal(result.usage.input_tokens, 21)
      assert.equal(result.usage.output_tokens, 6)
    },
  )
})

test('API OpenAI responses stream interrupt keeps usage and writes an error event', async () => {
  const events = [
    sse({ type: 'response.output_text.delta', delta: 'hi' }),
    sse({ type: 'response.in_progress', response: { usage: { input_tokens: 5, output_tokens: 2 } } }),
  ].join('')
  await withKernel(
    (req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(events)
        setTimeout(() => res.destroy(), 20)
      })
    },
    async (root) => {
      const res = downstream()
      const result = await runApiInference({
        cfg: { paths: { data: root } },
        res,
        protocol: 'openai.responses',
        clientStream: true,
        deliveryMode: 'verified',
        convertedBody: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
        inbound: {},
        converters: {
          writeSSEHeaders() {
            res.headersSent = true
          },
        },
        scheduler: { pick: openaiPick },
      })
      assert.equal(result.ok, false)
      assert.equal(result.terminalState, 'incomplete')
      assert.equal(result.usage.input_tokens, 5)
      assert.equal(result.usage.output_tokens, 2)
      assert.match(res.chunks.join(''), /"type":"api_error"/)
    },
  )
})
