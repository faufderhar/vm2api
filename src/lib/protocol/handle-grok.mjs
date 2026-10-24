/**
 * Grok (xAI) hop from handle-protocol. Node converts the body and picks the slot.
 * The slot's kin-grok-kernel owns the access token, the Grok Build headers, and the
 * SOCKS exit. Claude convert/pool and the Codex kernel never run here.
 */
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isGrokVm } from '../vm/vm-kind.mjs'
import { grokRoutingOf, isGrokProtocolAllowed } from './grok-route.mjs'
import { resolveGrokRequestModel } from './grok-model-policy.mjs'
import { keyAllowsVm, keyScopeFromRequest, vmPoolDenial } from '../admin/key-scope.mjs'
import { restrictCodexClient } from './codex-restriction.mjs'
import {
  anthropicToCodexResponses,
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  createAnthropicSseState,
  createResponsesSseEventNamer,
  responsesSseToAnthropicEvents,
  stripCodexIdentity,
} from './codex-convert.mjs'
import { extractOpenaiUsage, openaiAnthropicUsageFromExtract, disjointOpenaiUsage } from './openai-usage.mjs'
import { callGrokKernel, grokKernelEnvelope } from '../transport/grok-kernel-client.mjs'
import { ensureGrokKernel, trackGrokKernel, writeGrokKernelConfig } from '../transport/grok-kernel-supervisor.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { assertKernelProxyResolved } from '../vm/proxy-policy.mjs'
import { grokKernelExit } from '../oauth/grok-kernel-oauth.mjs'
import { persistGrokRateLimit, persistGrokRefreshRejected } from '../vm/grok-slot.mjs'
import { scopeAccountFromVm } from './jev-intercept.mjs'
import {
  grokSlotAllowsModel,
  isGrokFailoverError,
  orderGrokSessionSlots,
  pinGrokConversation,
  parkUntilFromHeaders,
} from '../pool/grok-slot-pool.mjs'
import { grokRuntime } from '../pool/openai-account-runtime.mjs'
import { codexFailoverBudget, codexFailureHold, isRetryableSameCodexAccount } from './handle-codex.mjs'
import { CLIENT_POOL_BUSY_MESSAGE, CLIENT_POOL_UNAVAILABLE_MESSAGE, ErrorCode } from '../core/errors.mjs'
import { applyOpenaiWashLog } from './openai-wash.mjs'
import { redactHeaders } from '../admin/request-log.mjs'
import { sessionIdForLog } from './log-fields.mjs'
import { grokCliRequestHeaders, grokCliUserAgent, grokRequestId, resolveGrokOutboundSession } from './grok-client.mjs'

export const GROK_VIA = 'grok-kernel'

const UPSTREAM_PATHS = Object.freeze({
  'openai.responses': '/v1/responses',
  'openai.chat': '/v1/chat/completions',
  'anthropic.messages': '/v1/messages',
})
const ERROR_BODY_MAX = 1024 * 1024
const WAIT_TIMEOUT_MIN_MS = 1000
const WAIT_TIMEOUT_MAX_MS = 120000
const DEFAULT_WAIT_TIMEOUT_MS = 30000
const DEFAULT_IDLE_TIMEOUT_MS = 180000

function upstreamAccept(stream) {
  return stream ? 'text/event-stream' : 'application/json'
}

function waitTimeoutMs(routing) {
  const n = Number(routing?.pool?.fallback_wait_timeout_ms)
  if (!Number.isFinite(n)) return DEFAULT_WAIT_TIMEOUT_MS
  return Math.min(WAIT_TIMEOUT_MAX_MS, Math.max(WAIT_TIMEOUT_MIN_MS, n))
}

function idleTimeoutMs(routing) {
  const n = Number(routing?.failover?.stream_idle_timeout_ms)
  return Number.isFinite(n) && n >= 5000 ? n : DEFAULT_IDLE_TIMEOUT_MS
}

function clientGoneSignal(req, res) {
  const controller = new AbortController()
  const onGone = () => controller.abort()
  req?.once?.('aborted', onGone)
  res?.once?.('close', onGone)
  return {
    signal: controller.signal,
    settle() {
      req?.off?.('aborted', onGone)
      res?.off?.('close', onGone)
    },
  }
}

function pinnedVmId(req) {
  const raw = String(req?.headers?.['x-kin-vm'] || '').trim()
  if (req?.apiKeyKind !== 'master') return null
  return isValidVmId(raw) ? raw : null
}

function anthropicSystemText(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return undefined
  const text = system
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : ''))
    .filter(Boolean)
    .join('\n')
  return text || undefined
}

/**
 * Caller fields that identify the end user or the caller's own client. grok-shell does not
 * send them; on a shared subscription they would show xAI one distinct user per tenant.
 * Prompt caching rides on x-grok-conv-id, which the kernel sends, not on prompt_cache_key.
 */
const GROK_CALLER_IDENTITY_KEYS = ['user', 'safety_identifier', 'prompt_cache_key', 'metadata']

function stripGrokCallerIdentity(body) {
  const next = stripCodexIdentity(body)
  for (const key of GROK_CALLER_IDENTITY_KEYS) delete next[key]
  return next
}

/**
 * Outbound body and upstream route per inbound protocol. Native modes pass the body through
 * (identity fields stripped); `anthropic.messages` convert goes through Responses like Codex.
 */
export function buildGrokOutbound(protocol, body, mode, { stream }) {
  const clean = stripGrokCallerIdentity(body)
  if (protocol === 'anthropic.messages' && mode === 'convert') {
    const converted = anthropicToCodexResponses({ ...clean, system: anthropicSystemText(clean.system) })
    return {
      path: UPSTREAM_PATHS['openai.responses'],
      body: { ...stripGrokCallerIdentity(converted), stream: true },
      convert: true,
    }
  }
  const path = UPSTREAM_PATHS[protocol]
  if (!path) return null
  const out = { ...clean, stream }
  let injectedUsage = false
  if (protocol === 'openai.chat' && stream && out.stream_options?.include_usage !== true) {
    out.stream_options = { ...(out.stream_options || {}), include_usage: true }
    injectedUsage = true
  }
  return { path, body: out, convert: false, injectedUsage }
}

function normalizeErrorBody(status, payload, text) {
  if (payload?.error && typeof payload.error === 'object') return payload
  const message =
    typeof payload?.error === 'string'
      ? payload.error
      : typeof payload?.message === 'string'
        ? payload.message
        : String(text || '').slice(0, 500) || `upstream HTTP ${status}`
  const code = typeof payload?.code === 'string' ? payload.code : status === 429 ? 'rate_limited' : 'upstream_error'
  const type = status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error'
  return { error: { type, code, message } }
}

async function readAll(stream, cap = ERROR_BODY_MAX) {
  const parts = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > cap) break
    parts.push(chunk)
  }
  return Buffer.concat(parts).toString('utf8')
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * One upstream call through the slot kernel. Streams call onLine(line) per SSE line.
 * Never throws for upstream/transport failures.
 */
export async function grokUpstreamCall({ projectRoot, vmId, envelope, stream, signal, idleMs, onLine, ops = {} }) {
  const forward = ops.callGrokKernel || ((request) => callGrokKernel({ projectRoot, vmId, ...request }))
  const startedAt = Date.now()
  const idle = new AbortController()
  const onParentAbort = () => idle.abort()
  signal?.addEventListener?.('abort', onParentAbort, { once: true })
  if (signal?.aborted) idle.abort()
  let timer = null
  const armIdle = () => {
    clearTimeout(timer)
    timer = setTimeout(() => idle.abort(), idleMs || DEFAULT_IDLE_TIMEOUT_MS)
    timer.unref?.()
  }
  let emitted = false
  let firstTokenAt = null
  try {
    armIdle()
    let res
    try {
      res = await forward({ envelope, signal: idle.signal })
    } catch (error) {
      return {
        ok: false,
        status: 0,
        transportError: true,
        emitted,
        body: { error: { type: 'api_error', code: 'upstream_transport', message: String(error?.message || error) } },
      }
    }
    const status = Number(res.statusCode) || 0
    const headers = res.headers || {}
    if (status >= 400 || res.kernelError) {
      const text = await readAll(res)
      const payload = parseJson(text)
      const kernelCode = res.kernelError ? String(payload?.error?.code || 'kernel_error') : ''
      return {
        ok: false,
        status: res.kernelError ? grokKernelErrorStatus(kernelCode) : status,
        headers,
        kernelError: !!res.kernelError,
        emitted,
        body: res.kernelError
          ? { error: { type: 'api_error', code: kernelCode, message: `grok-kernel: ${kernelCode}` } }
          : normalizeErrorBody(status, payload, text),
      }
    }
    if (!stream) {
      const text = await readAll(res, 64 * 1024 * 1024)
      armIdle()
      const payload = parseJson(text)
      if (!payload) {
        return {
          ok: false,
          status: 502,
          headers,
          emitted,
          body: {
            error: { type: 'api_error', code: 'upstream_protocol_error', message: 'upstream returned non-JSON' },
          },
        }
      }
      return { ok: true, status, headers, body: payload, emitted, ttftMs: Date.now() - startedAt }
    }
    let buffered = ''
    for await (const chunk of res) {
      armIdle()
      buffered += chunk.toString('utf8')
      let nl = buffered.indexOf('\n')
      while (nl !== -1) {
        const line = buffered.slice(0, nl).replace(/\r$/, '')
        buffered = buffered.slice(nl + 1)
        if (!emitted && line) {
          emitted = true
          firstTokenAt = Date.now()
        }
        await onLine(line)
        nl = buffered.indexOf('\n')
      }
    }
    if (buffered) await onLine(buffered.replace(/\r$/, ''))
    return { ok: true, status, headers, emitted, firstTokenAt, ttftMs: firstTokenAt ? firstTokenAt - startedAt : null }
  } catch (error) {
    const idleHit = idle.signal.aborted && !signal?.aborted
    return {
      ok: false,
      status: idleHit ? 504 : 0,
      transportError: !idleHit,
      emitted,
      committed: emitted,
      body: {
        error: {
          type: 'api_error',
          code: idleHit ? 'stream_idle_timeout' : 'upstream_transport',
          message: String(error?.message || error),
        },
      },
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onParentAbort)
  }
}

/** Kernel codes that mean this slot needs a new login. Everything else is worth a later retry. */
const GROK_LOGIN_REQUIRED = new Set(['refresh_rejected', 'grok_no_credential', 'grok_token_expired'])

/**
 * 401 sends the request to another slot and holds this one for 5 minutes. A token endpoint
 * hiccup (refresh_failed, oauth_transport, ...) is a 503: 30 seconds, like any upstream 5xx.
 */
export function grokKernelErrorStatus(code) {
  return GROK_LOGIN_REQUIRED.has(String(code || '')) ? 401 : 503
}

function dataJson(line) {
  if (typeof line !== 'string' || !line.startsWith('data:')) return null
  const raw = line.slice(5).trim()
  if (!raw || raw === '[DONE]') return null
  return parseJson(raw)
}

/** Running usage across stream lines for each wire shape. */
function createUsageTracker(shape) {
  let usage = null
  return {
    see(line) {
      const ev = dataJson(line)
      if (!ev) return
      if (shape === 'anthropic') {
        const start = ev.type === 'message_start' ? ev.message?.usage : null
        if (start) usage = { ...(usage || {}), ...start }
        if (ev.type === 'message_delta' && ev.usage) usage = { ...(usage || {}), ...ev.usage }
        return
      }
      const found = ev.response?.usage || ev.usage
      if (found && typeof found === 'object') usage = found
    },
    take(body) {
      if (shape === 'anthropic') return body?.usage || usage
      return body?.usage || body?.response?.usage || usage
    },
  }
}

/** A chat chunk that only carries usage (choices: []) we asked for ourselves. */
function isInjectedUsageChunk(line) {
  const ev = dataJson(line)
  return !!ev && Array.isArray(ev.choices) && ev.choices.length === 0 && !!ev.usage
}

function logUsage(logBag, usage, shape) {
  if (!usage) return
  if (shape === 'anthropic') {
    logBag.usage = usage
    logBag.input_tokens = usage.input_tokens ?? null
    logBag.output_tokens = usage.output_tokens ?? null
    logBag.cache_read_tokens = usage.cache_read_input_tokens ?? null
    logBag.cache_creation_tokens = usage.cache_creation_input_tokens ?? null
    return
  }
  const extracted = extractOpenaiUsage(usage)
  const disjoint = extracted ? openaiAnthropicUsageFromExtract(extracted) : null
  logBag.usage = disjointOpenaiUsage(usage)
  logBag.input_tokens = disjoint?.input_tokens ?? usage.input_tokens ?? usage.prompt_tokens ?? null
  logBag.output_tokens = disjoint?.output_tokens ?? usage.output_tokens ?? usage.completion_tokens ?? null
  logBag.cache_read_tokens = disjoint?.cache_read_input_tokens ?? extracted?.cached_tokens ?? null
  logBag.cache_creation_tokens = disjoint?.cache_creation_input_tokens ?? extracted?.cache_write_tokens ?? null
}

function grokAttemptsRepo(ops) {
  if (ops?.attemptsRepo) return ops.attemptsRepo
  return typeof ops?.getAttemptsRepo === 'function' ? ops.getAttemptsRepo() : null
}

function grokSelectionReason({ pin, sticky, ownsPin }) {
  if (pin) return 'pin'
  if (sticky && ownsPin) return 'sticky'
  return 'smart'
}

/** One upstream try for the log decision chain. Missing repo must not fail the request. */
function noteGrokAttempt(repo, requestId, attemptNo, fields) {
  if (!repo || !requestId) return
  try {
    repo.begin({
      requestId,
      attemptNo,
      vmId: fields.vmId,
      accountId: fields.accountId,
      model: fields.model,
      selectionReason: fields.selectionReason,
      waitMs: 0,
    })
    const transport = fields.result?.kernelError === true || fields.result?.transportError === true
    repo.complete(requestId, attemptNo, {
      upstreamStatus: Number(fields.result?.status) || null,
      errorScope: fields.result?.ok ? null : transport ? 'transport' : 'upstream',
      action: fields.result?.ok ? 'stop' : 'retry',
      downstreamCommitted: !!fields.committed,
      terminalState: fields.result?.ok ? 'verified' : transport ? 'transport_error' : 'error',
      ttftMs: fields.result?.ttftMs ?? null,
      latencyMs: Math.max(0, Date.now() - fields.startedAt),
    })
  } catch {}
}

/**
 * Candidates re-read on every admission, same contract as pickCodexCandidates: a request that
 * continues a stored response (`previous_response_id`) can only run on the slot that holds it.
 */
export function pickGrokCandidates(
  projectRoot,
  req,
  { stickyRouter = null, sessions = null, body = null, excluded = null, routing = {} } = {},
) {
  const pin = pinnedVmId(req)
  const model = body?.model || null
  const quotaPolicy = grokRoutingOf(routing).quota
  const scope = keyScopeFromRequest(req)
  const poolDenial = vmPoolDenial(scope)
  if (poolDenial) return { error: 'vm_pool_unavailable', message: poolDenial.message, ids: [], candidates: [] }
  if (scope.group_type !== 'all' && scope.group_type !== 'xai') {
    return { error: 'key_group_mismatch', ids: [], candidates: [] }
  }
  if (pin) {
    const vm = getVm(projectRoot, pin)
    if (!vm || !isGrokVm(vm)) return { error: 'platform_mismatch', pin, ids: [] }
    if (!keyAllowsVm(scope, vm)) return { error: 'key_group_mismatch', pin, ids: [] }
    if (!grokSlotAllowsModel(vm, model)) return { error: 'model_not_allowed', pin, ids: [] }
    const listed = listVms(projectRoot, routing).find((item) => item.id === pin) || vm
    const ordered = orderGrokSessionSlots([listed], { pin, excluded, quotaPolicy })
    return { ...ordered, pin, sticky: false, sessionKey: null, stickyKeys: [] }
  }
  const stickyKeys = stickyRouter?.collectPoolKeys?.(req, body || {}, { platform: 'xai' }) || []
  const sessionKey = stickyRouter?.extractPoolKey?.(req, body || {}, { platform: 'xai' }) || stickyKeys[0] || null
  const bound = sessionKey ? stickyRouter?.resolve?.(sessionKey) : null
  const vms = listVms(projectRoot, routing).filter((vm) => isGrokVm(vm) && keyAllowsVm(scope, vm))
  const continuesResponse = !!body?.previous_response_id && !!bound?.vmId
  if (scope.vm_pool_id && vms.length === 0 && !continuesResponse) {
    return { error: 'vm_pool_unavailable', message: '账号池没有可调度的 Grok 槽位', ids: [], candidates: [] }
  }
  const ordered = orderGrokSessionSlots(continuesResponse ? vms.filter((vm) => vm.id === bound.vmId) : vms, {
    boundVmId: bound?.vmId || null,
    sessionKey,
    sessionLimit: sessions,
    model,
    excluded,
    quotaPolicy,
  })
  const boundLeft = ordered.boundState === 'gone' || ordered.boundState === 'resting'
  if (bound?.vmId && sessionKey && boundLeft) {
    for (const key of stickyKeys.length ? stickyKeys : [sessionKey]) stickyRouter?.unbind?.(key)
    try {
      sessions?.drop?.(bound.vmId, sessionKey)
    } catch {}
  }
  if (continuesResponse && (boundLeft || ordered.error === 'candidates_exhausted')) {
    return { error: 'response_not_portable', ids: [], sessionKey, stickyKeys, boundVmId: bound.vmId }
  }
  return { ...ordered, sessionKey, stickyKeys }
}

async function admitGrokCandidate(projectRoot, req, opts, { deadline, signal }) {
  let woken = false
  for (;;) {
    const picked = pickGrokCandidates(projectRoot, req, opts)
    const livePolicy = grokRoutingOf(opts.routing).quota
    if (picked.error && picked.error !== 'capacity_unavailable') return { picked }
    const holdHome = picked.affinity === 'wait' || !!(picked.sticky && picked.home)
    const queue = holdHome ? (picked.candidates || []).slice(0, 1) : picked.candidates || []
    let followClaim = false
    for (const candidate of queue) {
      const lease = grokRuntime.tryAcquire(candidate.id, {
        concurrency: candidate.concurrency,
        maxRpm: candidate.maxRpm,
        quotaPolicy: livePolicy,
      })
      if (!lease) continue
      const pinned = pinGrokConversation(opts.stickyRouter, picked, candidate.id)
      if (pinned && pinned !== candidate.id) {
        lease.release()
        followClaim = true
        break
      }
      return { picked, vmId: candidate.id, lease }
    }
    if (followClaim) continue
    if (woken) grokRuntime.wakeWaiter()
    const now = Date.now()
    if (now >= deadline) return { picked: { ...picked, error: 'capacity_unavailable', ids: [] } }
    const retryAt = Number(picked.retryAt)
    const sliceDeadline = Number.isFinite(retryAt) && retryAt > now ? Math.min(deadline, retryAt) : deadline
    let waited
    try {
      waited = await grokRuntime.waitForCapacity({ deadline: sliceDeadline, signal })
    } catch (error) {
      if (error?.code === 'pool_wait_queue_full') return { picked: { error: 'pool_wait_queue_full', ids: [] } }
      throw error
    }
    if (waited.aborted) return { picked: { error: 'client_cancelled', ids: [] } }
    woken = !!waited.woken
  }
}

function ingestGrokHop(projectRoot, vm, result, now = Date.now()) {
  // The kernel refreshes on its own; a rejected refresh token must mark the slot like Node's refresher does.
  if (result?.kernelError && result.body?.error?.code === 'refresh_rejected') {
    persistGrokRefreshRejected(projectRoot, vm.id, now)
    return
  }
  if (Number(result?.status) === 429 && !result.kernelError) {
    persistGrokRateLimit(projectRoot, vm.id, {
      until: parkUntilFromHeaders(result.headers || {}, now),
      reason: 'rate_limited',
    })
    return
  }
  const bagUntil = Number(vm?.grok?.limited_until)
  if (result?.ok && Number.isFinite(bagUntil) && bagUntil > 0) persistGrokRateLimit(projectRoot, vm.id, { until: null })
}

/** Kernel config for this slot's exit, or null when it has none (or the exit is refused). */
async function writeHopKernelConfig(projectRoot, vm, routing, ops = {}) {
  const exit = grokKernelExit(vm, { hostProxyUrl: ops.hostProxyUrlForVm || hostProxyUrlForVm })
  if (!exit) return null
  const write = ops.writeGrokKernelConfig || writeGrokKernelConfig
  let proxyUrl = exit.proxyUrl
  if (proxyUrl && write === writeGrokKernelConfig) {
    try {
      proxyUrl = await assertKernelProxyResolved(vm, proxyUrl)
    } catch (error) {
      if (error?.code === 'proxy_host_blocked' || error?.code === 'ipv6_disabled') return null
      throw error
    }
  }
  try {
    return write(projectRoot, vm, { ...exit, proxyUrl, routing })
  } catch {
    return null
  }
}

export async function runGrokSlotHop({
  projectRoot,
  vm,
  routing,
  outbound,
  stream,
  signal,
  onLine,
  ops = {},
  headers = null,
  kernelConfig = null,
}) {
  // handleGrokProtocol already wrote it for this hop to read the agent id.
  const written = kernelConfig || (await writeHopKernelConfig(projectRoot, vm, routing, ops))
  if (!written) {
    return {
      ok: false,
      status: 503,
      body: { error: { type: 'api_error', code: 'grok_proxy_required', message: 'Grok 槽位没有可用的 SOCKS5 出口' } },
    }
  }
  if (!ops.callGrokKernel) {
    const ready = await (ops.ensureGrokKernel || ensureGrokKernel)({ projectRoot, vmId: vm.id })
    if (!ready?.ok) {
      return {
        ok: false,
        status: 503,
        kernelError: true,
        body: {
          error: {
            type: 'api_error',
            code: ready?.reason || 'grok_kernel_unavailable',
            message: 'Grok 出站内核没有启动',
          },
        },
      }
    }
  }
  const idleMs = idleTimeoutMs(routing)
  const release = trackGrokKernel(vm.id)
  try {
    return await grokUpstreamCall({
      projectRoot,
      vmId: vm.id,
      envelope: grokKernelEnvelope({
        method: 'POST',
        path: outbound.path,
        body: outbound.body,
        stream,
        purpose: 'inference',
        sessionId: headers?.['x-grok-session-id'] || '',
        modelId: headers?.['x-grok-model-override'] || outbound.body?.model || '',
        requestId: headers?.['x-grok-req-id'] || '',
        agentId: written?.agentId || headers?.['x-grok-agent-id'] || '',
      }),
      stream,
      signal,
      idleMs,
      onLine,
      ops,
    })
  } finally {
    release()
  }
}

export async function handleGrokProtocol({
  req,
  res,
  protocol,
  ctx,
  inbound,
  logBag,
  stats,
  json,
  writeSSEHeaders,
  routing = {},
  cfg,
  projectRoot,
  ops = {},
  stickyRouter = null,
  sessions = null,
  body = null,
  captureOutbound = false,
  requestStartedAt = Date.now(),
  accountGate = null,
}) {
  const grok = grokRoutingOf(routing)
  logBag.via = GROK_VIA
  // The detail pane shows this as the client. xAI sees the Grok CLI, not the caller's Codex UA.
  logBag.user_agent = grokCliUserAgent()
  const caller = resolveGrokOutboundSession({ req, inbound, body: ctx.body || inbound, routing })
  if (!logBag.session_id) logBag.session_id = sessionIdForLog(caller.callerSession)
  const allowed = isGrokProtocolAllowed(protocol, routing)
  if (!allowed.ok) {
    stats.errors++
    logBag.error_code = allowed.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: allowed.code,
        message:
          allowed.code === 'grok_disabled'
            ? 'Grok 平台未启用'
            : `protocol '${protocol}' is not allowed on the Grok hop`,
      },
    })
  }
  const modelCheck = resolveGrokRequestModel(ctx.body?.model)
  if (!modelCheck.ok) {
    stats.errors++
    logBag.error_code = modelCheck.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: modelCheck.code,
        message: `model '${modelCheck.requested}' is disabled by gateway Grok model policy`,
        param: 'model',
      },
    })
  }
  // xai/grok-4.3 or a panel alias goes upstream as the bare model id; pricing and slot gates read it too.
  if (ctx.body && modelCheck.model !== ctx.body.model) {
    ctx = { ...ctx, body: { ...ctx.body, model: modelCheck.model } }
    body = ctx.body
  }
  const restriction = restrictCodexClient(req.headers, ctx.body || inbound, { clients: grok.clients }, protocol)
  if (!restriction.ok) {
    stats.errors++
    logBag.error_code = restriction.code
    return json(res, 403, { error: { type: 'permission_error', code: restriction.code, message: restriction.message } })
  }
  const stream = inbound?.stream === true || ctx.body?.stream === true
  const outbound = buildGrokOutbound(protocol, ctx.body, allowed.mode, { stream })
  if (!outbound) {
    stats.errors++
    logBag.error_code = 'protocol_not_allowed'
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'protocol_not_allowed',
        message: `protocol '${protocol}' unsupported`,
      },
    })
  }
  applyOpenaiWashLog(logBag, {
    inboundPath: ctx.path,
    inboundProtocol: protocol,
    converted: outbound.convert,
    outboundBody: outbound.body,
  })
  if (captureOutbound) logBag.outbound_body = outbound.body
  logBag.outbound_headers = redactHeaders({
    authorization: 'Bearer ***',
    'content-type': 'application/json',
    'user-agent': grokCliUserAgent(),
    'x-grok-client-version': '1.0.62',
    'x-grok-client-identifier': 'grok-shell',
  })
  const upstreamStream = outbound.convert ? true : stream
  const shape = protocol === 'anthropic.messages' && !outbound.convert ? 'anthropic' : 'openai'
  const pickOpts = { stickyRouter, sessions, body: body || ctx.body || inbound, excluded: new Set(), routing }
  const deadline = Date.now() + waitTimeoutMs(routing)
  const gone = clientGoneSignal(req, res)
  const budget = codexFailoverBudget(routing)
  const sameRetryDelay = Number(routing?.failover?.same_account_retry_delay_ms)
  const sameRetryDelayMs =
    Number.isFinite(sameRetryDelay) && sameRetryDelay >= 0 ? Math.min(10_000, sameRetryDelay) : 100
  logBag.attempt_count = 0
  let last = null
  let hops = 0
  let attempts = 0
  let switches = 0
  let counted = false
  try {
    for (;;) {
      const admitted = await admitGrokCandidate(projectRoot, req, pickOpts, { deadline, signal: gone.signal })
      const picked = admitted.picked
      if (!admitted.lease) {
        if (picked.error === 'client_cancelled') {
          logBag.final_state = 'cancelled'
          return
        }
        if (last) break
        return rejectGrokAdmission({ res, json, stats, logBag, picked, model: ctx.body?.model })
      }
      const lease = admitted.lease
      const vm = getVm(projectRoot, admitted.vmId)
      if (!vm || !isGrokVm(vm)) {
        lease.release()
        pickOpts.excluded.add(admitted.vmId)
        continue
      }
      attempts += 1
      if (attempts > budget.maxAttempts) {
        lease.release()
        break
      }
      if (!counted) {
        counted = true
        stats.requests++
        stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
      }
      if (accountGate) {
        logBag.vm_id = vm.id
        if (await accountGate(scopeAccountFromVm(vm))) {
          lease.release()
          return
        }
      }
      const stickyKeys = picked.stickyKeys?.length ? picked.stickyKeys : picked.sessionKey ? [picked.sessionKey] : []
      const stickyBound = picked.sessionKey ? stickyRouter?.resolve?.(picked.sessionKey) : null
      const claimsWindow = !!picked.sessionKey && (!picked.home || picked.home === vm.id)
      let windowGen = null
      if (claimsWindow) {
        try {
          windowGen = sessions?.touch?.(vm.id, picked.sessionKey) ?? null
        } catch {}
      }
      const ownsPin = !!stickyBound?.vmId && stickyBound.vmId === vm.id
      const attemptsRepo = grokAttemptsRepo(ops)
      const selectionReason = grokSelectionReason({ pin: picked.pin, sticky: picked.sticky, ownsPin })
      const outboundSession = resolveGrokOutboundSession({
        req,
        inbound,
        body: outbound.body,
        routing,
        vmId: vm.id,
        bound: stickyBound,
        epoch: stickyBound?.generation ? String(stickyBound.generation) : `${requestStartedAt}:${vm.id}`,
      })
      const outboundSessionId = outboundSession.sessionId
      logBag.outbound_session_id = sessionIdForLog(outboundSessionId)
      if (!logBag.session_id) logBag.session_id = sessionIdForLog(outboundSession.callerSession)
      const bindSticky = (sessionId = null) => {
        if (!picked.sessionKey || !stickyRouter?.bind) return
        const payload = { accountId: vm.id, vmId: vm.id }
        if (sessionId) payload.sessionId = sessionId
        for (const key of stickyKeys) stickyRouter.bind(key, payload)
      }
      const leaveSticky = () => {
        if (!ownsPin || !picked.sessionKey) return
        try {
          sessions?.drop?.(vm.id, picked.sessionKey)
        } catch {}
        for (const key of stickyKeys) stickyRouter?.unbind?.(key)
      }
      try {
        hops += 1
        logBag.vm_id = vm.id
        logBag.attempt_count = hops
        const usage = createUsageTracker(shape)
        const nameSseEvent = createResponsesSseEventNamer()
        const anthropicSse = outbound.convert ? createAnthropicSseState() : null
        const chunks = []
        let hopEmitted = false
        const onLine = async (line) => {
          hopEmitted = true
          usage.see(line)
          if (!stream) {
            chunks.push(line)
            return
          }
          if (!res.headersSent) writeSSEHeaders(res)
          if (outbound.convert) {
            const mapped = responsesSseToAnthropicEvents(line, anthropicSse)
            if (mapped) res.write(mapped)
            return
          }
          if (protocol === 'openai.responses') {
            const named = nameSseEvent(line)
            if (named) res.write(named)
            return
          }
          if (outbound.injectedUsage && isInjectedUsageChunk(line)) return
          res.write(`${line}\n`)
        }
        const runHop = async () => {
          const requestId = grokRequestId()
          const written = await writeHopKernelConfig(projectRoot, vm, routing, ops)
          // The log shows the User-Agent this slot's kernel really sends.
          if (written?.platform) logBag.user_agent = grokCliUserAgent(undefined, written.platform)
          const headers = grokCliRequestHeaders({
            platform: written?.platform,
            model: outbound.body?.model,
            sessionId: outboundSessionId,
            requestId,
            agentId: written?.agentId || '',
          })
          logBag.outbound_headers = redactHeaders({
            authorization: 'Bearer ***',
            'content-type': 'application/json',
            accept: upstreamAccept(upstreamStream),
            ...headers,
          })
          return runGrokSlotHop({
            projectRoot,
            vm,
            routing,
            outbound,
            stream: upstreamStream,
            signal: gone.signal,
            onLine,
            ops,
            headers,
            kernelConfig: written,
          })
        }
        const recordAttempt = (startedAt, result) =>
          noteGrokAttempt(attemptsRepo, ops.requestId, hops, {
            vmId: vm.id,
            accountId: vm.id,
            model: outbound.body?.model,
            selectionReason,
            startedAt,
            result,
            committed: !!(result?.ok || hopEmitted),
          })
        let attemptStarted = Date.now()
        let result = await runHop()
        recordAttempt(attemptStarted, result)
        let sameAccountRetries = result?.refreshed ? 1 : 0
        while (
          sameAccountRetries < budget.maxSameAccountRetries &&
          attempts < budget.maxAttempts &&
          !result.kernelError &&
          isRetryableSameCodexAccount(result, { headersSent: res.headersSent || hopEmitted, signal: gone.signal })
        ) {
          sameAccountRetries += 1
          attempts += 1
          hops += 1
          logBag.attempt_count = hops
          logBag.grok_same_account_retried = sameAccountRetries
          await new Promise((resolve) => setTimeout(resolve, sameRetryDelayMs))
          hopEmitted = false
          attemptStarted = Date.now()
          result = await runHop()
          recordAttempt(attemptStarted, result)
        }
        if (result?.refreshed) logBag.grok_token_refreshed = true
        logBag.first_token_ms = Number.isFinite(result?.firstTokenAt)
          ? Math.max(0, result.firstTokenAt - requestStartedAt)
          : (result?.ttftMs ?? null)
        ingestGrokHop(projectRoot, vm, result)
        last = result
        if (result?.ok) {
          bindSticky(outboundSessionId)
          logUsage(logBag, usage.take(result.body), shape)
          grokRuntime.reportAttempt(vm.id, 'succeeded', result.ttftMs ?? null)
          logBag.final_state = 'verified'
          logBag.upstream_model = outbound.body.model
          if (hops > 1) logBag.grok_failed_over = true
          if (!stream) {
            const out = outbound.convert
              ? codexBodyToAnthropicMessage(assembleCodexBodyFromSse(chunks, {}), outbound.body.model)
              : result.body
            return json(res, 200, out)
          }
          if (!res.headersSent) writeSSEHeaders(res)
          return res.end()
        }
        grokRuntime.reportAttempt(vm.id, 'failed', result?.ttftMs ?? null)
        const hold = codexFailureHold(result)
        if (hold) grokRuntime.holdAccount(vm.id, hold)
        if (res.headersSent || hopEmitted) {
          stats.errors++
          logBag.error_code = result?.body?.error?.code || 'grok_upstream'
          logBag.upstream_status = result?.status || 0
          logBag.final_state = 'incomplete'
          return res.end()
        }
        if (isGrokFailoverError(result)) {
          pickOpts.excluded.add(vm.id)
          leaveSticky()
          switches += 1
          if (switches > budget.maxSwitches || attempts >= budget.maxAttempts) break
          continue
        }
        break
      } finally {
        lease.release()
        if (claimsWindow) {
          try {
            sessions?.release?.(vm.id, picked.sessionKey, { gen: windowGen })
          } catch {}
        }
      }
    }
  } finally {
    gone.settle()
  }
  stats.errors++
  logBag.error_code = last?.body?.error?.code || 'grok_upstream'
  logBag.upstream_status = last?.status || 0
  // The caller's own key was accepted. A 401 here is a slot credential; SDKs would read it as theirs.
  if (Number(last?.status) === 401) {
    return json(res, 503, {
      error: {
        type: 'api_error',
        code: last?.body?.error?.code || 'grok_upstream_auth',
        message: CLIENT_POOL_UNAVAILABLE_MESSAGE,
      },
    })
  }
  return json(res, last?.status || 502, last?.body || { error: { type: 'api_error', code: 'grok_upstream' } })
}

/** No seat was admitted and nothing ran: say which gate stopped the request. */
function rejectGrokAdmission({ res, json, stats, logBag, picked, model }) {
  stats.errors++
  logBag.error_code = picked.error || 'no_grok_vm'
  const fail = (status, type, code, message, extra = {}) =>
    json(res, status, { error: { type, code, message, ...extra } })
  switch (picked.error) {
    case 'platform_mismatch':
      return fail(400, 'invalid_request_error', 'platform_mismatch', `vm '${picked.pin}' is not a Grok slot`)
    case 'key_group_mismatch':
      return fail(403, 'permission_error', 'key_group_mismatch', '此密钥不能调用 xai')
    case 'vm_pool_unavailable':
      return fail(403, 'permission_error', 'vm_pool_unavailable', picked.message || '账号池不可用')
    case 'model_not_allowed':
      return fail(
        400,
        'invalid_request_error',
        'model_not_allowed',
        `model '${model || ''}' is not allowed on any Grok slot`,
        {
          param: 'model',
        },
      )
    case 'response_not_portable':
      return fail(
        409,
        'invalid_request_error',
        'response_not_portable',
        'previous_response_id 所在的 Grok 账号已不可用；该响应无法在其他账号继续，请携带完整上下文重新发起',
      )
    case 'capacity_unavailable':
    case 'session_window_full':
    case 'pool_wait_queue_full': {
      const waitMs = Number(picked.retryAt) - Date.now()
      res.setHeader?.('retry-after', String(Math.max(1, waitMs > 0 ? Math.ceil(waitMs / 1000) : 0)))
      return fail(429, 'rate_limit_error', 'pool_overloaded', CLIENT_POOL_BUSY_MESSAGE, {
        details: { reason: picked.error },
      })
    }
    case 'pool_resting': {
      const waitMs = Number(picked.retryAt) - Date.now()
      res.setHeader?.('retry-after', String(Math.max(1, Math.ceil(waitMs / 1000) || 1)))
      return fail(503, 'api_error', ErrorCode.POOL_UNAVAILABLE, CLIENT_POOL_UNAVAILABLE_MESSAGE, {
        details: { reason: 'pool_resting' },
      })
    }
    case 'quota_exhausted': {
      const waitMs = Number(picked.retryAt) - Date.now()
      if (waitMs > 0) res.setHeader?.('retry-after', String(Math.ceil(waitMs / 1000)))
      return fail(503, 'api_error', 'quota_exhausted', 'Grok 号池均被上游限流')
    }
    default:
      return fail(503, 'api_error', picked.error || 'no_grok_vm', 'no Grok slot is configured')
  }
}
