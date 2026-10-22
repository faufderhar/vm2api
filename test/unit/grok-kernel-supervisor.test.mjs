import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A stand-in kernel: serves /internal/health on the configured socket. A `<config>.hot`
// file present at start makes it the current binary (hot_reload, api 2); without it, an old one.
const FAKE_KERNEL = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const configPath = process.argv[2]
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
// Decided at start, like a real binary.
const current = fs.existsSync(configPath + '.hot')
try { fs.unlinkSync(config.socket_path) } catch {}
http.createServer((req, res) => {
  if (req.headers['x-kin-internal-token'] !== config.internal_token) { res.writeHead(401); return res.end() }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(current ? { ok: true, hot_reload: true, api: 2 } : { ok: true }))
}).listen(config.socket_path)
process.on('SIGTERM', () => process.exit(0))
`

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-grok-supervisor-'))
  const bin = path.join(root, 'bin', 'kin-grok-kernel')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, FAKE_KERNEL, { mode: 0o755 })
  process.env.KIN_GROK_KERNEL_BIN = bin
  const supervisor = await import('../../src/lib/transport/grok-kernel-supervisor.mjs')
  const vm = { id: `vm-${path.basename(root)}` }
  const pids = []
  t.after(() => {
    supervisor.stopGrokKernel(vm.id)
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, bin, vm, supervisor, pids }
}

test('a config change reaches a hot-reload kernel without a restart', async (t) => {
  const { root, vm, supervisor, pids } = await setup(t)
  const paths = supervisor.writeGrokKernelConfig(root, vm, { proxyUrl: 'socks5h://203.0.113.1:1080' })
  fs.writeFileSync(`${paths.configPath}.hot`, '')
  assert.equal((await supervisor.ensureGrokKernel({ projectRoot: root, vmId: vm.id })).ok, true)
  const pid = Number(fs.readFileSync(paths.pidPath, 'utf8'))
  pids.push(pid)
  const changed = supervisor.writeGrokKernelConfig(root, vm, { proxyUrl: 'socks5h://203.0.113.2:1080' })
  const again = await supervisor.ensureGrokKernel({ projectRoot: root, vmId: vm.id })
  assert.equal(again.ok, true)
  assert.equal(Number(fs.readFileSync(paths.pidPath, 'utf8')), pid)
  assert.ok(alive(pid))
  assert.equal(fs.readFileSync(paths.stampPath, 'utf8').trim(), changed.stamp)
})

test('an old kernel left by a previous Node process is replaced when its config changed', async (t) => {
  const { root, bin, vm, supervisor, pids } = await setup(t)
  const paths = supervisor.writeGrokKernelConfig(root, vm, { proxyUrl: 'socks5h://203.0.113.1:1080' })
  // Started by "another" Node process: not in this supervisor's child table.
  const orphan = spawn(process.execPath, [bin, paths.configPath], { stdio: 'ignore', detached: true })
  orphan.unref()
  pids.push(orphan.pid)
  fs.writeFileSync(paths.pidPath, `${orphan.pid}\n`)
  fs.writeFileSync(paths.stampPath, 'stale-stamp\n')
  const ready = await supervisor.ensureGrokKernel({ projectRoot: root, vmId: vm.id })
  assert.equal(ready.ok, true)
  assert.equal(alive(orphan.pid), false)
  const replacement = Number(fs.readFileSync(paths.pidPath, 'utf8'))
  pids.push(replacement)
  assert.notEqual(replacement, orphan.pid)
  assert.ok(alive(replacement))
})

test('a pid file that names some other process is not killed', async (t) => {
  const { root, vm, supervisor, pids } = await setup(t)
  const paths = supervisor.writeGrokKernelConfig(root, vm, {})
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
  stranger.unref()
  pids.push(stranger.pid)
  fs.writeFileSync(paths.pidPath, `${stranger.pid}\n`)
  fs.writeFileSync(paths.stampPath, 'stale-stamp\n')
  assert.equal((await supervisor.ensureGrokKernel({ projectRoot: root, vmId: vm.id })).ok, true)
  pids.push(Number(fs.readFileSync(paths.pidPath, 'utf8')))
  assert.ok(alive(stranger.pid))
})

test('the kernel config is not rewritten when nothing changed', async (t) => {
  const { root, vm, supervisor } = await setup(t)
  const paths = supervisor.writeGrokKernelConfig(root, vm, { proxyUrl: 'socks5h://203.0.113.1:1080' })
  const before = fs.statSync(paths.configPath)
  await new Promise((resolve) => setTimeout(resolve, 20))
  supervisor.writeGrokKernelConfig(root, vm, { proxyUrl: 'socks5h://203.0.113.1:1080' })
  assert.equal(fs.statSync(paths.configPath).mtimeMs, before.mtimeMs)
})

test('a running kernel from an older binary is replaced even when its config did not change', async (t) => {
  const { root, bin, vm, supervisor, pids } = await setup(t)
  const paths = supervisor.writeGrokKernelConfig(root, vm, { proxyUrl: 'socks5h://203.0.113.1:1080' })
  const stamp = supervisor.writeGrokKernelConfig(root, vm, { proxyUrl: 'socks5h://203.0.113.1:1080' }).stamp
  const old = spawn(process.execPath, [bin, paths.configPath], { stdio: 'ignore', detached: true })
  old.unref()
  pids.push(old.pid)
  fs.writeFileSync(paths.pidPath, `${old.pid}\n`)
  fs.writeFileSync(paths.stampPath, `${stamp}\n`)
  for (let i = 0; i < 40 && !(await supervisor.grokKernelHealth(root, vm.id)).ok; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // The replacement is the current binary.
  fs.writeFileSync(`${paths.configPath}.hot`, '')
  assert.equal((await supervisor.ensureGrokKernel({ projectRoot: root, vmId: vm.id })).ok, true)
  assert.equal(alive(old.pid), false)
  const replacement = Number(fs.readFileSync(paths.pidPath, 'utf8'))
  pids.push(replacement)
  assert.equal((await supervisor.grokKernelHealth(root, vm.id)).api, 2)
})
