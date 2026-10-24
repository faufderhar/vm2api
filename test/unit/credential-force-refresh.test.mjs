import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test

async function fakeKernel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-force-refresh-'))
  const runDir = path.join(root, 'vm-01', 'run')
  const homeDir = path.join(root, 'vm-01', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  const tokenFile = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenFile, 'internal-test\n', { mode: 0o600 })
  await writeWorkerCredentialFile(homeDir, {
    access_token: 'access-still-fresh',
    refresh_token: 'refresh-still-fresh',
    expires_at: Date.now() + 6 * 3600_000,
  })
  const socket = path.join(runDir, 'kernel.sock')
  let posts = 0
  const server = http.createServer((_req, res) => {
    if (_req.url === '/internal/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, engine: 'rust', healthy: true, ready_slots: 4 }))
      return
    }
    posts += 1
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'authentication_error' } }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  const vm = {
    id: 'vm-01',
    runtime: { worker_socket: socket, kernel_socket: socket, worker_run_dir: runDir, worker_token_file: tokenFile },
  }
  return {
    root,
    homeDir,
    selected: { vmId: 'vm-01', accountId: 'account-a', vm, exec: { vmId: 'vm-01', homeDir, vm } },
    posts: () => posts,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function fakeResponse() {
  const listeners = {}
  return {
    headersSent: false,
    statusCode: 200,
    on(event, fn) {
      listeners[event] = fn
    },
    once() {},
    off() {},
    setHeader() {},
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    write() {
      return true
    },
    end() {},
    finish() {
      listeners.finish?.()
    },
  }
}

unixTest('handle-protocol forwards force:true into the slot credential refresh', async () => {
  const kernel = await fakeKernel()
  const logPath = path.join(kernel.root, 'docker-argv.log')
  const dockerBin = path.join(kernel.root, 'docker')
  fs.writeFileSync(
    dockerBin,
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nprintf '%s\\n' '{"ok":true,"status":200,"body":{"refreshed":false,"has_access":true,"has_refresh":true},"headers":{}}'\n`,
    { mode: 0o755 },
  )
  const prevDocker = process.env.KIN_DOCKER_BIN
  const prevKernel = process.env.KIN_KERNEL_BIN
  process.env.KIN_DOCKER_BIN = dockerBin
  process.env.KIN_KERNEL_BIN = path.join(kernel.root, 'kin-kernel')
  const handler = createHandleProtocol({
    json: (res, status) => {
      res.statusCode = status
      return status
    },
    writeSSEHeaders(res) {
      res.headersSent = true
    },
    readBody: async (req) => req.body,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000, stream_idle_timeout_ms: 5000 },
      paths: { data: kernel.root, project: kernel.root },
    },
    requestLog: {
      start: () => ({ request_id: 'force-refresh', mode: 'off' }),
      finish() {},
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: path.join(kernel.root, 'routing.json'),
    routingConfig: { compatibility: {}, failover: {} },
    thinkingOwners: new ThinkingOwnerStore({ db: new DatabaseSync(':memory:') }),
    failoverRunner: {
      async run(opts) {
        const prepared = await opts.applyAttempt(opts.canonicalBody, kernel.selected)
        return opts.callAttempt({
          candidate: kernel.selected,
          body: prepared.body,
          attemptMeta: prepared.meta,
          deliveryMode: 'realtime',
          signal: new AbortController().signal,
          onCommit() {},
        })
      },
    },
  })
  const request = (body) => ({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.304 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1' },
    body,
    once() {},
    off() {},
  })
  try {
    for (const stream of [false, true]) {
      const res = fakeResponse()
      await handler.handleProtocol(
        request({ model: 'claude-haiku-4-5', stream, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
        res,
        'anthropic.messages',
        '/v1/messages',
      )
      res.finish()
    }
    const argvLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
    const forced = argvLog.split('\n').filter((line) => line.includes('oauth refresh') && line.includes('--force'))
    assert.equal(forced.length, 2, `wrappers dropped force; docker argv:\n${argvLog}`)
    assert.ok(kernel.posts() >= 2)
  } finally {
    if (prevDocker === undefined) delete process.env.KIN_DOCKER_BIN
    else process.env.KIN_DOCKER_BIN = prevDocker
    if (prevKernel === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prevKernel
    await kernel.close()
  }
})
