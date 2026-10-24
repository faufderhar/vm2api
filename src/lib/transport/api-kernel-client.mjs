import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

const MAX_BODY = 64 * 1024 * 1024

export function apiKernelPaths(cfg = {}) {
  const dataDir = cfg.paths?.data || cfg.dataDir || path.join(process.cwd(), 'data')
  const project = cfg.paths?.project || process.cwd()
  const socketPath = process.env.KIN_API_KERNEL_SOCK || path.join(dataDir, 'run', 'api-kernel.sock')
  return {
    socketPath,
    tokenPath: process.env.KIN_API_KERNEL_TOKEN || path.join(dataDir, 'run', 'api-kernel.token'),
    binPath: process.env.KIN_API_KERNEL_BIN || path.join(project, 'bin', 'kin-api-kernel'),
    pidPath: path.join(path.dirname(socketPath), 'api-kernel.pid'),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readToken(tokenPath) {
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim()
  } catch {
    return ''
  }
}

export function ensureApiKernelToken(tokenPath) {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  if (fs.existsSync(tokenPath)) return readToken(tokenPath)
  const token = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

function readPid(pidPath) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8'), 10)
    return Number.isInteger(pid) && pid > 1 && pid !== process.pid ? pid : 0
  } catch {
    return 0
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Guards against pid reuse where /proc is available; elsewhere the pid file is trusted.
function pidIsKernel(pid, binPath) {
  if (!fs.existsSync('/proc/self/cmdline')) return true
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(path.basename(binPath))
  } catch {
    return false
  }
}

// A gracefully exiting kernel unlinks the socket path, so it must be gone before the replacement binds.
async function stopStaleKernel(pidPath, binPath) {
  const pid = readPid(pidPath)
  if (!pid || !pidAlive(pid) || !pidIsKernel(pid, binPath)) return
  for (const [signal, waitMs] of [
    ['SIGTERM', 2000],
    ['SIGKILL', 1000],
  ]) {
    try {
      process.kill(pid, signal)
    } catch {
      return
    }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return
      await sleep(50)
    }
  }
}

export async function startApiKernelProcess(cfg) {
  const { socketPath, tokenPath, binPath, pidPath } = apiKernelPaths(cfg)
  if (!fs.existsSync(binPath)) return { ok: false, reason: 'bin_missing', binPath }
  const token = ensureApiKernelToken(tokenPath)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  await stopStaleKernel(pidPath, binPath)
  try {
    fs.rmSync(socketPath, { force: true })
  } catch {}
  // The token goes in the environment: argv is world-readable in /proc, environ is not.
  const child = spawn(binPath, ['-socket', socketPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, KIN_API_KERNEL_SECRET: token },
  })
  child.once('error', (err) => console.error(`[api-kernel] spawn error: ${err.message}`))
  child.unref()
  if (child.pid) fs.writeFileSync(pidPath, String(child.pid))
  return { ok: true, pid: child.pid, socketPath }
}

export function apiKernelHealth(cfg, { timeoutMs = 500 } = {}) {
  const { socketPath, tokenPath } = apiKernelPaths(cfg)
  const token = readToken(tokenPath)
  return new Promise((resolve) => {
    const headers = {}
    if (token) {
      headers['x-kin-internal-token'] = token
      headers['x-internal-token'] = token
    }
    const req = http.request(
      {
        socketPath,
        path: '/internal/health',
        method: 'GET',
        headers,
      },
      (res) => {
        resolve({ ok: res.statusCode === 200, status: res.statusCode })
      },
    )
    req.setTimeout(Math.max(1, timeoutMs), () => {
      req.destroy()
      resolve({ ok: false, reason: 'health_timeout' })
    })
    req.on('error', (err) => resolve({ ok: false, reason: 'health_error', error: err.message, code: err.code }))
    req.end()
  })
}

/** Spawn kin-api-kernel and wait until its unix socket answers /internal/health. */
export async function bootApiKernel(cfg, { waitMs = 8000 } = {}) {
  if (process.env.KIN_CRS_MOCK === '1') {
    ensureApiKernelToken(apiKernelPaths(cfg).tokenPath)
    return { ok: true, skipped: 'mock' }
  }
  ensureApiKernelToken(apiKernelPaths(cfg).tokenPath)
  const started = await startApiKernelProcess(cfg)
  if (!started.ok) {
    console.error(`[api-kernel] boot failed: ${started.reason}${started.binPath ? ` (${started.binPath})` : ''}`)
    process.exit(1)
  }
  const deadline = Date.now() + Math.max(200, Number(waitMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await apiKernelHealth(cfg)
    if (last.ok) return { ok: true, ...started }
    await sleep(100)
  }
  console.error('[api-kernel] health timeout', last)
  process.exit(1)
}

export function superviseApiKernel(cfg, { intervalMs = 5000, failThreshold = 3 } = {}) {
  if (process.env.KIN_CRS_MOCK === '1') return { stop() {} }
  let failures = 0
  let busy = false
  let stopped = false
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const health = await apiKernelHealth(cfg, { timeoutMs: 2000 })
      if (health.ok) {
        failures = 0
        return
      }
      failures += 1
      if (failures < failThreshold || stopped) return
      failures = 0
      console.error(`[api-kernel] ${failThreshold} consecutive health failures, respawning`, health)
      const started = await startApiKernelProcess(cfg)
      if (!started.ok) console.error(`[api-kernel] respawn failed: ${started.reason}`)
    } catch (err) {
      console.error(`[api-kernel] supervisor error: ${err?.message || err}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(tick, Math.max(10, Number(intervalMs) || 5000))
  timer.unref?.()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

export function apiKernelSnapshot(cfg) {
  const { socketPath, binPath } = apiKernelPaths(cfg)
  return {
    bin: fs.existsSync(binPath),
    socket: fs.existsSync(socketPath),
  }
}

export function forwardApi({
  cfg,
  method = 'POST',
  url,
  headers = {},
  body,
  proxyUrl = '',
  dialIp = '',
  signal,
  timeoutMs = 300_000,
  stream = false,
  requireProxy = false,
  upstreamTimeoutMs,
} = {}) {
  return new Promise((resolve, reject) => {
    const { socketPath, tokenPath } = apiKernelPaths(cfg)
    const token = readToken(tokenPath)
    const envelope = {
      method,
      url,
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      proxy_url: proxyUrl || '',
    }
    if (dialIp) envelope.dial_ip = dialIp
    if (stream) envelope.stream = true
    if (requireProxy) envelope.require_proxy = true
    if (upstreamTimeoutMs !== undefined) envelope.timeout_ms = Math.max(0, Math.trunc(Number(upstreamTimeoutMs) || 0))
    const payload = Buffer.from(JSON.stringify(envelope))
    const reqHeaders = {
      'content-type': 'application/json',
      'content-length': String(payload.length),
    }
    if (token) {
      reqHeaders['x-kin-internal-token'] = token
      reqHeaders['x-internal-token'] = token
    }
    const started = Date.now()
    const attempt = (left) => {
      const req = http.request(
        {
          socketPath,
          path: '/internal/forward',
          method: 'POST',
          headers: reqHeaders,
          signal,
        },
        (res) => {
          res.kernelError = res.headers['x-kin-kernel-error'] === '1'
          resolve(res)
        },
      )
      const timer = setTimeout(
        () => {
          req.destroy(
            Object.assign(new Error(`api kernel timeout after ${timeoutMs}ms`), { code: 'api_kernel_timeout' }),
          )
        },
        Math.max(1, timeoutMs - (Date.now() - started)),
      )
      timer.unref?.()
      req.once('close', () => clearTimeout(timer))
      req.once('error', (err) => {
        clearTimeout(timer)
        const retryable = err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED'
        if (retryable && left > 0 && !signal?.aborted) {
          setTimeout(() => attempt(left - 1), 80)
          return
        }
        reject(err)
      })
      req.write(payload)
      req.end()
    }
    attempt(15)
  })
}

export async function readApiJson(stream, limit = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const c of stream) {
    size += c.length
    if (size > limit) throw new Error('api kernel body too large')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
