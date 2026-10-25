/**
 * One kin-grok-kernel process per Grok slot. It listens on
 * vms/<id>/run/grok-kernel.sock and is the only process that reads the slot
 * access token. Cluster slots still dial out through that node's SOCKS exit
 * (`proxy_url`); the process itself stays on the control plane, same as Codex.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_DISCOVERY_URL,
  GROK_OAUTH_SCOPE,
  grokBaseUrl,
  grokOauthConfig,
} from '../protocol/grok-route.mjs'
import { assertProxyAllowed } from '../vm/proxy-policy.mjs'
import { writeJsonIfChanged } from '../vm/vm-file.mjs'
import { isNativeNodeVm } from '../cluster/placement.mjs'
import { grokPlatformInfo } from '../protocol/grok-client.mjs'
import { existingBin, pidAlive } from '../core/proc.mjs'

/** Kernel features Node relies on: 2 = /internal/oauth. An older running kernel is replaced. */
export const GROK_KERNEL_API = 2

const starts = new Map()
const sockets = new Map()
const inFlight = new Map()
// Project root seen per slot, so stopGrokKernel can find a kernel it did not spawn.
const roots = new Map()

function kernelEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)))
}

export function grokKernelBinPath() {
  const env = existingBin(process.env.KIN_GROK_KERNEL_BIN)
  if (env) return env
  const kernel = String(process.env.KIN_KERNEL_BIN || process.env.KIN_API_KERNEL_BIN || '').trim()
  if (kernel) {
    const sibling = existingBin(path.join(path.dirname(kernel), 'kin-grok-kernel'))
    if (sibling) return sibling
  }
  return existingBin(path.resolve('bin/kin-grok-kernel'))
}

export function grokKernelPaths(projectRoot, vmId) {
  const runDir = path.join(projectRoot, 'vms', vmId, 'run')
  return {
    runDir,
    socketPath: path.join(runDir, 'grok-kernel.sock'),
    configPath: path.join(runDir, 'grok-kernel.json'),
    tokenPath: path.join(runDir, 'grok-kernel.token'),
    stampPath: path.join(runDir, 'grok-kernel.stamp'),
    pidPath: path.join(runDir, 'grok-kernel.pid'),
    platformPath: path.join(runDir, 'grok-platform.json'),
    agentIdPath: path.join(runDir, 'grok-agent-id'),
    credentialPath: path.join(projectRoot, 'vms', vmId, 'grok-credentials.json'),
    refreshLockPath: path.join(runDir, 'grok-refresh.lock'),
  }
}

function readOrCreateSecret(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 })
  return secret
}

/**
 * The client platform a slot reports in its User-Agent, fixed at first use and kept.
 * A slot that already has an agent id has been reporting this host's platform: keep
 * that, so its User-Agent never changes. A new slot on a macOS node (Apple Silicon only)
 * starts as macos/aarch64; every other new slot reports this host.
 */
function pinnedPlatform(paths, vm, { nativeNode = isNativeNodeVm } = {}) {
  try {
    const stored = JSON.parse(fs.readFileSync(paths.platformPath, 'utf8'))
    if (stored?.os && stored?.arch) return { os: String(stored.os), arch: String(stored.arch) }
  } catch {}
  const seasoned = fs.existsSync(paths.agentIdPath)
  let mac = false
  try {
    mac = !seasoned && nativeNode(vm)
  } catch {}
  const platform = mac ? grokPlatformInfo('darwin', 'arm64') : grokPlatformInfo()
  fs.writeFileSync(paths.platformPath, `${JSON.stringify(platform)}\n`, { mode: 0o600 })
  return platform
}

function configStamp(config) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        proxy_url: config.proxy_url,
        proxy_required: config.proxy_required,
        base_url: config.base_url,
        oauth: config.oauth,
        platform: config.platform,
      }),
    )
    .digest('hex')
}

export function writeGrokKernelConfig(
  projectRoot,
  vm,
  { proxyUrl = '', proxyRequired = true, routing = {}, nativeNode } = {},
) {
  if (!projectRoot || !vm?.id) return null
  const proxy = String(proxyUrl || '')
  if (proxy) assertProxyAllowed({ url: proxy })
  const paths = grokKernelPaths(projectRoot, vm.id)
  roots.set(vm.id, projectRoot)
  fs.mkdirSync(paths.runDir, { recursive: true })
  const oauth = grokOauthConfig(routing)
  const resolved = oauth.ok ? oauth.config : {}
  // Before the agent id is created: its absence is what marks a new slot.
  const platform = pinnedPlatform(paths, vm, nativeNode ? { nativeNode } : {})
  const agentId = readOrCreateSecret(paths.agentIdPath)
  const config = {
    socket_path: paths.socketPath,
    credentials_path: paths.credentialPath,
    agent_id_path: paths.agentIdPath,
    refresh_lock_path: paths.refreshLockPath,
    internal_token: readOrCreateSecret(paths.tokenPath),
    proxy_url: proxy,
    proxy_required: proxyRequired !== false,
    base_url: grokBaseUrl(routing),
    platform,
    oauth: {
      token_url: String(resolved.token_url || ''),
      client_id: String(resolved.client_id || GROK_OAUTH_CLIENT_ID),
      discovery_url: GROK_OAUTH_DISCOVERY_URL,
      scope: String(resolved.scope || GROK_OAUTH_SCOPE),
      refresh_skew_sec: Number(resolved.refresh_skew_sec) || 300,
    },
  }
  // Called on every hop. Same bytes leave the file alone; a change lands in one rename,
  // so the kernel never reads half a config when it reloads.
  writeJsonIfChanged(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return { ...paths, agentId, platform, stamp: configStamp(config) }
}

export function grokKernelInFlight(vmId) {
  return inFlight.get(vmId) || 0
}

export function trackGrokKernel(vmId) {
  inFlight.set(vmId, grokKernelInFlight(vmId) + 1)
  return () => {
    const next = grokKernelInFlight(vmId) - 1
    if (next <= 0) inFlight.delete(vmId)
    else inFlight.set(vmId, next)
  }
}

function childHasExited(child) {
  return !child || child.exitCode != null || child.signalCode != null
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(childHasExited(child)), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export function stopGrokKernel(vmId) {
  const child = starts.get(vmId)
  starts.delete(vmId)
  if (!child) {
    // Spawned before a Node restart: only the pid file knows it.
    const projectRoot = roots.get(vmId)
    if (projectRoot) stopOrphanKernel(grokKernelPaths(projectRoot, vmId)).catch(() => {})
    return null
  }
  const socketPath = sockets.get(vmId)
  child.once('exit', () => {
    sockets.delete(vmId)
    if (socketPath) {
      try {
        fs.unlinkSync(socketPath)
      } catch {}
    }
  })
  try {
    if (!childHasExited(child)) child.kill('SIGTERM')
  } catch {}
  return child
}

/** The pid in grok-kernel.pid, only while it is still this slot's kernel. */
function orphanKernelPid(paths) {
  let pid = 0
  try {
    pid = Number(fs.readFileSync(paths.pidPath, 'utf8').trim())
  } catch {
    return 0
  }
  if (!Number.isInteger(pid) || pid <= 1) return 0
  try {
    // A reused pid must not be killed: check it runs the kernel on this slot's config.
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    const isKernel = cmdline.some((arg) => path.basename(arg) === 'kin-grok-kernel')
    return isKernel && cmdline.includes(paths.configPath) ? pid : 0
  } catch {
    return 0
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !pidAlive(pid)
}

/** A kernel this process did not spawn, such as one left over from before a Node restart. */
async function stopOrphanKernel(paths) {
  const pid = orphanKernelPid(paths)
  if (!pid) return true
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
  if (!(await waitForPidExit(pid, 2000))) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    if (!(await waitForPidExit(pid, 1000))) return false
  }
  try {
    fs.unlinkSync(paths.socketPath)
  } catch {}
  return true
}

async function recycle(vmId, paths) {
  const socketPath = paths.socketPath
  const child = starts.get(vmId)
  if (!child) return stopOrphanKernel(paths)
  stopGrokKernel(vmId)
  const exited = await waitForChildExit(child, 2000)
  if (!exited) {
    try {
      child.kill('SIGKILL')
    } catch {}
    const killed = await waitForChildExit(child, 1000)
    if (!killed) {
      starts.set(vmId, child)
      return false
    }
  }
  if (socketPath) {
    try {
      fs.unlinkSync(socketPath)
    } catch {}
  }
  return true
}

export function grokKernelHealth(projectRoot, vmId, { timeoutMs = 500 } = {}) {
  const { socketPath, tokenPath } = grokKernelPaths(projectRoot, vmId)
  let token = ''
  try {
    token = fs.readFileSync(tokenPath, 'utf8').trim()
  } catch {
    return Promise.resolve({ ok: false, reason: 'token_missing' })
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: '/internal/health',
        method: 'GET',
        headers: { 'x-kin-internal-token': token },
        timeout: timeoutMs,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (body.length < 4096) body += chunk
        })
        res.on('end', () => {
          let parsed = null
          try {
            parsed = JSON.parse(body)
          } catch {}
          resolve({
            ok: res.statusCode === 200,
            status: res.statusCode,
            hotReload: parsed?.hot_reload === true,
            api: Number(parsed?.api) || 1,
            clientVersion: typeof parsed?.client_version === 'string' ? parsed.client_version : null,
          })
        })
        res.on('error', () => resolve({ ok: false, reason: 'health_error' }))
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, reason: 'timeout' })
    })
    req.on('error', (error) => resolve({ ok: false, reason: error?.code || 'health_error' }))
    req.end()
  })
}

export async function ensureGrokKernel({ projectRoot, vmId, timeoutMs = 8000 } = {}) {
  const bin = grokKernelBinPath()
  if (!bin) return { ok: false, reason: 'bin_missing' }
  const paths = grokKernelPaths(projectRoot, vmId)
  roots.set(vmId, projectRoot)
  if (!fs.existsSync(paths.configPath)) return { ok: false, reason: 'config_missing' }
  let wanted = ''
  try {
    wanted = configStamp(JSON.parse(fs.readFileSync(paths.configPath, 'utf8')))
  } catch {
    return { ok: false, reason: 'config_missing' }
  }
  let stamped = ''
  try {
    stamped = fs.readFileSync(paths.stampPath, 'utf8').trim()
  } catch {}
  const quickMs = Math.min(800, Math.max(200, Number(timeoutMs) || 800))
  const configChanged = !!(wanted && stamped && wanted !== stamped)
  const running = await waitForHealth(projectRoot, vmId, quickMs)
  // A kernel from an older binary (left running across an upgrade) lacks endpoints Node calls.
  const outdated = running.ok && (running.health?.api || 1) < GROK_KERNEL_API
  if (running.ok && !configChanged && !outdated) return { ok: true, reused: true }
  if (running.ok) {
    if (!outdated && running.health?.hotReload) {
      // The kernel re-reads grok-kernel.json on its next request. Nothing to restart.
      fs.writeFileSync(paths.stampPath, `${wanted}\n`, { mode: 0o600 })
      return { ok: true, reused: true }
    }
    // An older kernel only reads its config at start. Restart it when no other
    // request is streaming through it; the next quiet moment picks the change up.
    if (grokKernelInFlight(vmId) > 1) return { ok: true, reused: true, stale: true }
    const gone = await recycle(vmId, paths)
    if (!gone) return { ok: false, reason: 'recycle_timeout' }
  }
  const current = starts.get(vmId)
  if (current && !childHasExited(current)) return waitForHealth(projectRoot, vmId, timeoutMs)
  try {
    fs.unlinkSync(paths.socketPath)
  } catch {}
  const child = spawn(bin, [paths.configPath], { env: kernelEnv(), stdio: 'ignore', detached: true })
  child.unref()
  starts.set(vmId, child)
  sockets.set(vmId, paths.socketPath)
  fs.writeFileSync(paths.stampPath, `${wanted}\n`, { mode: 0o600 })
  // After a Node restart this is the only handle on the detached kernel.
  if (child.pid) fs.writeFileSync(paths.pidPath, `${child.pid}\n`, { mode: 0o600 })
  return waitForHealth(projectRoot, vmId, timeoutMs)
}

async function waitForHealth(projectRoot, vmId, timeoutMs) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await grokKernelHealth(projectRoot, vmId, { timeoutMs: 500 })
    if (last.ok) return { ok: true, health: last }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return { ok: false, reason: last.reason || 'not_ready', health: last }
}
