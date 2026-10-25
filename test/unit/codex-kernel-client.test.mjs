import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { codexKernelPaths, withCodexKernelExec } from '../../src/lib/transport/codex-kernel-client.mjs'
import {
  ensureCodexKernel,
  finishCodexRecycle,
  stopCodexKernel,
  writeCodexKernelConfig,
  shouldRecycleCodexKernel,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import fs from 'node:fs'
import os from 'node:os'
import { registerPlatformEgressEndpoint } from '../../src/lib/vm/proxy-policy.mjs'

// Fixtures bind slots to a 127.0.0.1 SOCKS, which production blocks by default.
process.env.VM2API_ALLOW_PRIVATE_PROXY = '1'

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]
const LOCAL_CODEX = {
  id: 'vm-codex',
  platform: 'openai',
  proxy: { id: 'px-local', scheme: 'local', host: 'local', port: 0 },
}

function setEnv(t, values) {
  const keys = [...new Set([...PROXY_ENV_KEYS, ...Object.keys(values)])]
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  for (const k of PROXY_ENV_KEYS) delete process.env[k]
  Object.assign(process.env, values)
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}
test('codex kernel socket is not worker.sock', () => {
  const exec = {
    homeDir: '/tmp/vms/vm-codex/cli-home',
    vm: { id: 'vm-codex', runtime: {} },
  }
  const paths = codexKernelPaths(exec)
  assert.equal(paths.socketPath, path.join('/tmp/vms/vm-codex/run', 'codex-kernel.sock'))
  const remapped = withCodexKernelExec(exec)
  assert.match(remapped.vm.runtime.worker_socket, /codex-kernel\.sock$/)
})

test('writeCodexKernelConfig writes bound SOCKS proxy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  const vm = { id: 'vm-codex', proxy: { url: 'socks5://127.0.0.1:1080' } }
  const written = writeCodexKernelConfig(root, vm, {
    token: 'secret',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    proxyRequired: true,
  })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, true)
  assert.equal(cfg.proxy_url, 'socks5h://127.0.0.1:1080')
  assert.equal(cfg.socket_path, written.socketPath)
  assert.equal(cfg.internal_token, 'secret')
  assert.equal(cfg.max_request_bytes, 32 * 1024 * 1024)
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeCodexKernelConfig follows the panel request body limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-body-'))
  const vm = { id: 'vm-codex', proxy: { url: 'socks5://127.0.0.1:1080' } }
  const written = writeCodexKernelConfig(root, vm, {
    token: 'secret',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    proxyRequired: true,
    routing: { failover: { max_request_mib: 64 } },
  })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.max_request_bytes, 64 * 1024 * 1024)
  fs.rmSync(root, { recursive: true, force: true })
})

test('codex kernel recycles a body-limit change only when the slot is alone', () => {
  assert.equal(shouldRecycleCodexKernel({ wanted: 64 << 20, stamped: 32 << 20, inFlight: 1 }), true)
  assert.equal(shouldRecycleCodexKernel({ wanted: 64 << 20, stamped: 32 << 20, inFlight: 0 }), true)
  assert.equal(shouldRecycleCodexKernel({ wanted: 64 << 20, stamped: 32 << 20, inFlight: 2 }), false)
  assert.equal(shouldRecycleCodexKernel({ wanted: 32 << 20, stamped: 32 << 20, inFlight: 1 }), false)
  assert.equal(shouldRecycleCodexKernel({ wanted: 64 << 20, stamped: 0, inFlight: 1 }), false)
})

function holdProcess(exitOnTerm) {
  const script = exitOnTerm
    ? 'process.on("SIGTERM",()=>process.exit(0)); process.stdout.write("ready"); setInterval(()=>{},1e6)'
    : 'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1e6)'
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  if (!child.pid) throw new Error('failed to spawn hold process')
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.once('data', () => resolve(child))
  })
}

test('a child that ignores SIGTERM keeps the live socket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-recycle-'))
  const socket = path.join(dir, 'codex-kernel.sock')
  fs.writeFileSync(socket, 'busy')
  const child = await holdProcess(false)
  try {
    const gone = await finishCodexRecycle(child, socket, { termMs: 150, killMs: 0 })
    assert.equal(gone.exited, false)
    assert.equal(fs.readFileSync(socket, 'utf8'), 'busy')
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the socket is removed only after the child exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-recycle-'))
  const socket = path.join(dir, 'codex-kernel.sock')
  fs.writeFileSync(socket, 'busy')
  const child = await holdProcess(true)
  try {
    const gone = await finishCodexRecycle(child, socket, { termMs: 1000, killMs: 200 })
    assert.equal(gone.exited, true)
    assert.equal(fs.existsSync(socket), false)
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writeCodexKernelConfig fail-closes proxy_required without a URL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  const written = writeCodexKernelConfig(
    root,
    { id: 'vm-codex' },
    { token: 'secret', proxyUrl: '', proxyRequired: true },
  )
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, true)
  assert.equal(cfg.proxy_url, '')
  fs.rmSync(root, { recursive: true, force: true })
})

test('local egress without a deployment proxy is a direct exit', (t) => {
  setEnv(t, {})
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const written = writeCodexKernelConfig(root, LOCAL_CODEX, {
    token: 'secret',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    proxyRequired: true,
  })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_required, false)
  assert.equal(cfg.proxy_url, '')
})

test('local egress hands the kernel the deployment proxy and fails closed on it', (t) => {
  setEnv(t, { HTTPS_PROXY: 'http://proxy.test:8443', HTTP_PROXY: 'http://other.test:3128' })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const written = writeCodexKernelConfig(root, LOCAL_CODEX, { token: 'secret', proxyUrl: '', proxyRequired: false })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_url, 'http://proxy.test:8443')
  assert.equal(cfg.proxy_required, true)
})
test('a node slot on local egress keeps the node forwarder instead of this host proxy', (t) => {
  // Production policy: only the registered node forwarder may sit on loopback.
  setEnv(t, { HTTPS_PROXY: 'http://proxy.test:8443', VM2API_ALLOW_PRIVATE_PROXY: '' })
  t.after(registerPlatformEgressEndpoint('127.0.0.1', 19001))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const written = writeCodexKernelConfig(
    root,
    { ...LOCAL_CODEX, node_id: 'node-a' },
    { token: 'secret', proxyUrl: 'socks5h://127.0.0.1:19001', proxyRequired: true },
  )
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.proxy_url, 'socks5h://127.0.0.1:19001')
  assert.equal(cfg.proxy_required, true)
})

test('codex kernel starts without inherited proxy variables', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const out = path.join(root, 'env.txt')
  const bin = path.join(root, 'fake-kernel')
  fs.writeFileSync(bin, `#!/bin/sh\nenv > "${out}.tmp" && mv "${out}.tmp" "${out}"\n`, { mode: 0o755 })
  setEnv(t, { HTTPS_PROXY: 'http://proxy.test:8443', no_proxy: 'chatgpt.com', KIN_CODEX_KERNEL_BIN: bin })
  const exec = {
    vmId: 'vm-codex',
    homeDir: path.join(root, 'vm-codex', 'cli-home'),
    vm: { id: 'vm-codex', runtime: {} },
  }
  t.after(() => stopCodexKernel('vm-codex'))
  await ensureCodexKernel(exec, { timeoutMs: 300 })
  for (let i = 0; i < 40 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50))
  const keys = fs
    .readFileSync(out, 'utf8')
    .split('\n')
    .map((line) => line.split('=')[0])
  assert.ok(keys.includes('KIN_CODEX_KERNEL_BIN'))
  assert.deepEqual(
    keys.filter((k) => /^(https?|all|no|ftp)_proxy$/i.test(k)),
    [],
  )
  // The fixture sets VM2API_ALLOW_PRIVATE_PROXY=1 for the gateway; the kernel must not inherit it.
  assert.ok(!keys.includes('VM2API_ALLOW_PRIVATE_PROXY'))
})
