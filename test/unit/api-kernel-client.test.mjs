import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apiKernelPaths,
  forwardApi,
  readApiJson,
  superviseApiKernel,
} from '../../src/lib/transport/api-kernel-client.mjs'

const ENV_KEYS = ['KIN_API_KERNEL_SOCK', 'KIN_API_KERNEL_TOKEN', 'KIN_API_KERNEL_BIN', 'KIN_CRS_MOCK']

function isolate(t, prefix) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, cfg: { paths: { data: root, project: root } } }
}

async function fakeKernel(t, cfg, respond) {
  const { socketPath } = apiKernelPaths(cfg)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      seen.push({ raw, envelope: JSON.parse(raw), headers: req.headers })
      respond(res)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return seen
}

function okJson(res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
}

test('forwardApi keeps the legacy envelope byte-identical', async (t) => {
  const { cfg } = isolate(t, 'kin-akc-legacy-')
  const seen = await fakeKernel(t, cfg, okJson)
  const res = await forwardApi({
    cfg,
    url: 'https://api.example.com/v1/messages',
    headers: { 'x-api-key': 'sk' },
    body: { model: 'm' },
    proxyUrl: 'socks5h://127.0.0.1:1080',
  })
  assert.deepEqual(await readApiJson(res), { ok: true })
  assert.equal(
    seen[0].raw,
    JSON.stringify({
      method: 'POST',
      url: 'https://api.example.com/v1/messages',
      headers: { 'x-api-key': 'sk' },
      body: '{"model":"m"}',
      proxy_url: 'socks5h://127.0.0.1:1080',
    }),
  )
  assert.equal(res.kernelError, false)
})

test('forwardApi sends stream, require_proxy and timeout_ms when requested', async (t) => {
  const { cfg } = isolate(t, 'kin-akc-flags-')
  const seen = await fakeKernel(t, cfg, okJson)
  const res = await forwardApi({
    cfg,
    url: 'https://api.x.ai/v1/responses',
    body: '{}',
    proxyUrl: 'http://127.0.0.1:8080',
    stream: true,
    requireProxy: true,
    upstreamTimeoutMs: 45_000,
  })
  await readApiJson(res)
  const env = seen[0].envelope
  assert.equal(env.stream, true)
  assert.equal(env.require_proxy, true)
  assert.equal(env.timeout_ms, 45_000)
  assert.equal(env.proxy_url, 'http://127.0.0.1:8080')
})

test('forwardApi omits timeout_ms unless upstreamTimeoutMs is passed', async (t) => {
  const { cfg } = isolate(t, 'kin-akc-timeout-')
  const seen = await fakeKernel(t, cfg, okJson)
  await readApiJson(await forwardApi({ cfg, url: 'https://a.example', body: '{}', timeoutMs: 5000, stream: false }))
  assert.equal('timeout_ms' in seen[0].envelope, false)
  assert.equal('stream' in seen[0].envelope, false)
  assert.equal('require_proxy' in seen[0].envelope, false)
})

test('forwardApi marks kernel-generated errors', async (t) => {
  const { cfg } = isolate(t, 'kin-akc-kerr-')
  const replies = [
    (res) => {
      res.writeHead(400, { 'content-type': 'application/json', 'x-kin-kernel-error': '1' })
      res.end('{"ok":false,"error":{"code":"proxy_required"}}')
    },
    (res) => {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end('{"error":"upstream"}')
    },
  ]
  await fakeKernel(t, cfg, (res) => replies.shift()(res))
  const kernelRes = await forwardApi({ cfg, url: 'https://a.example', body: '{}', requireProxy: true })
  assert.equal(kernelRes.statusCode, 400)
  assert.equal(kernelRes.kernelError, true)
  assert.equal((await readApiJson(kernelRes)).error.code, 'proxy_required')
  const upstreamRes = await forwardApi({ cfg, url: 'https://a.example', body: '{}' })
  assert.equal(upstreamRes.statusCode, 502)
  assert.equal(upstreamRes.kernelError, false)
  await readApiJson(upstreamRes)
})

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

test('superviseApiKernel respawns an unhealthy kernel and kills the stale pid', async (t) => {
  const { root, cfg } = isolate(t, 'kin-akc-sup-')
  const marker = path.join(root, 'spawns.log')
  const bin = path.join(root, 'bin', 'kin-api-kernel')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, `#!/bin/sh\necho $$ >> '${marker}'\nwhile :; do sleep 1; done\n`, { mode: 0o755 })
  const pids = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').map(Number) : [])
  t.after(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  })

  const supervisor = superviseApiKernel(cfg, { intervalMs: 20, failThreshold: 2 })
  t.after(() => supervisor.stop())
  assert.ok(await waitFor(() => pids().length >= 2), 'kernel was not respawned twice')
  supervisor.stop()
  const settled = () => {
    const all = pids()
    return all.slice(0, -1).every((pid) => !pidAlive(pid)) && pidAlive(all.at(-1))
  }
  assert.ok(await waitFor(settled), 'stale kernel pids still alive')
  assert.equal(Number(fs.readFileSync(apiKernelPaths(cfg).pidPath, 'utf8')), pids().at(-1))
})

test('superviseApiKernel is a no-op in mock mode', async (t) => {
  const { root, cfg } = isolate(t, 'kin-akc-mock-')
  process.env.KIN_CRS_MOCK = '1'
  const bin = path.join(root, 'bin', 'kin-api-kernel')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, `#!/bin/sh\ntouch '${path.join(root, 'spawned')}'\n`, { mode: 0o755 })
  const supervisor = superviseApiKernel(cfg, { intervalMs: 10, failThreshold: 1 })
  await new Promise((r) => setTimeout(r, 150))
  supervisor.stop()
  assert.equal(fs.existsSync(path.join(root, 'spawned')), false)
})
