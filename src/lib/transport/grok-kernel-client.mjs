/**
 * Talk to one slot's kin-grok-kernel. The envelope has the upstream path and
 * the already converted JSON. It does not carry an access token.
 */
import http from 'node:http'
import fs from 'node:fs'
import { grokKernelPaths } from './grok-kernel-supervisor.mjs'

export function grokKernelEnvelope({
  method,
  path,
  query = '',
  body = null,
  stream = false,
  purpose,
  sessionId = '',
  modelId = '',
  requestId = '',
  agentId = '',
} = {}) {
  return {
    method,
    path,
    query,
    body,
    stream: !!stream,
    purpose,
    session_id: String(sessionId ?? ''),
    model_id: String(modelId ?? ''),
    request_id: String(requestId ?? ''),
    agent_id: String(agentId ?? ''),
  }
}

/** `timeoutMs` bounds the wait for response headers, not how long a stream may run. */
export function callGrokKernel({ projectRoot, vmId, envelope, signal, timeoutMs = 300_000 } = {}) {
  const { socketPath, tokenPath } = grokKernelPaths(projectRoot, vmId)
  let token = ''
  try {
    token = fs.readFileSync(tokenPath, 'utf8').trim()
  } catch {}
  const payload = Buffer.from(JSON.stringify(envelope || {}))
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const attempt = (left) => {
      const req = http.request(
        {
          socketPath,
          path: '/internal/forward',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...(token ? { 'x-kin-internal-token': token } : {}),
          },
          signal,
        },
        (res) => {
          // The limit is for the response head. The body is a stream that the caller's idle timer watches.
          clearTimeout(timer)
          res.kernelError = res.headers['x-kin-kernel-error'] === '1'
          resolve(res)
        },
      )
      const timer = setTimeout(
        () => {
          req.destroy(
            Object.assign(new Error(`grok kernel timeout after ${timeoutMs}ms`), { code: 'grok_kernel_timeout' }),
          )
        },
        Math.max(1, timeoutMs - (Date.now() - started)),
      )
      timer.unref?.()
      req.once('close', () => clearTimeout(timer))
      req.once('error', (error) => {
        clearTimeout(timer)
        const retryable = error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED'
        if (retryable && left > 0 && !signal?.aborted) {
          setTimeout(() => attempt(left - 1), 80)
          return
        }
        reject(error)
      })
      req.write(payload)
      req.end()
    }
    attempt(15)
  })
}

export async function readGrokKernelJson(stream, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > limit) throw new Error('grok kernel body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
