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
  grokBaseUrl,
  grokOauthConfig,
} from '../protocol/grok-route.mjs'

const starts = new Map()
const sockets = new Map()
const inFlight = new Map()

function kernelEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)))
}

function existingBin(candidate) {
  const bin = String(candidate || '').trim()
  if (!bin) return ''
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return bin
  } catch {
    return ''
  }
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

function configStamp(config) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        proxy_url: config.proxy_url,
        proxy_required: config.proxy_required,
        base_url: config.base_url,
        oauth: config.oauth,
        client_version: config.client_version,
      }),
    )
    .digest('hex')
}

export function writeGrokKernelConfig(projectRoot, vm, { proxyUrl = '', proxyRequired = true, routing = {} } = {}) {
  if (!projectRoot || !vm?.id) return null
  const paths = grokKernelPaths(projectRoot, vm.id)
  fs.mkdirSync(paths.runDir, { recursive: true })
  const oauth = grokOauthConfig(routing)
  const resolved = oauth.ok ? oauth.config : {}
  const agentId = readOrCreateSecret(paths.agentIdPath)
  const config = {
    socket_path: paths.socketPath,
    credentials_path: paths.credentialPath,
    agent_id_path: paths.agentIdPath,
    refresh_lock_path: paths.refreshLockPath,
    internal_token: readOrCreateSecret(paths.tokenPath),
    proxy_url: String(proxyUrl || ''),
    proxy_required: proxyRequired !== false,
    base_url: grokBaseUrl(routing),
    client_version: '1.0.62',
    oauth: {
      token_url: String(resolved.token_url || ''),
      client_id: String(resolved.client_id || GROK_OAUTH_CLIENT_ID),
      discovery_url: GROK_OAUTH_DISCOVERY_URL,
      refresh_skew_sec: Number(resolved.refresh_skew_sec) || 300,
    },
  }
  fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return { ...paths, agentId, stamp: configStamp(config) }
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
  if (!child) return null
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

async function recycle(vmId, socketPath) {
  const child = stopGrokKernel(vmId)
  if (!child) return true
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
        res.resume()
        resolve({ ok: res.statusCode === 200, status: res.statusCode })
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
  if (wanted && stamped && wanted !== stamped && grokKernelInFlight(vmId) <= 1) {
    const gone = await recycle(vmId, paths.socketPath)
    if (!gone) return { ok: false, reason: 'recycle_timeout' }
  }
  const live = await waitForHealth(projectRoot, vmId, Math.min(800, Math.max(200, Number(timeoutMs) || 800)))
  if (live.ok) return { ok: true, reused: true }
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
