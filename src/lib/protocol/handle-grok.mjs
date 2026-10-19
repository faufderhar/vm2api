/**
 * Grok (xAI) hop from handle-protocol. Requests leave through kin-api-kernel with the slot's
 * SOCKS5 as proxy_url (require_proxy), carrying the slot's OAuth bearer. Claude convert/pool and
 * the Codex kernel never run here.
 */
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isGrokVm } from '../vm/vm-kind.mjs'
import { grokBaseUrl, grokRoutingOf, isGrokProtocolAllowed } from './grok-route.mjs'
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
import { forwardApi } from '../transport/api-kernel-client.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { persistGrokRateLimit } from '../vm/grok-slot.mjs'
import { ensureGrokAccessToken } from '../oauth/grok-token.mjs'
import { scopeAccountFromVm } from './jev-intercept.mjs'
import {
  grokSlotAllowsModel,
  isGrokFailoverError,
  orderGrokSessionSlots,
  parkUntilFromHeaders,
} from '../pool/grok-slot-pool.mjs'
import { grokRuntime } from '../pool/openai-account-runtime.mjs'
import { codexFailoverBudget, codexFailureHold, isRetryableSameCodexAccount } from './handle-codex.mjs'
import { CLIENT_POOL_BUSY_MESSAGE, CLIENT_POOL_UNAVAILABLE_MESSAGE, ErrorCode } from '../core/errors.mjs'
import { applyOpenaiWashLog } from './openai-wash.mjs'
import { redactHeaders } from '../admin/request-log.mjs'

export const GROK_VIA = 'grok-api'

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
 * Outbound body and upstream route per inbound protocol. Native modes pass the body through
 * (identity fields stripped); `anthropic.messages` convert goes through Responses like Codex.
 */
export function buildGrokOutbound(protocol, body, mode, { stream }) {
  const clean = stripCodexIdentity(body)
  if (protocol === 'anthropic.messages' && mode === 'convert') {
    const converted = anthropicToCodexResponses({ ...clean, system: anthropicSystemText(clean.system) })
    return { path: UPSTREAM_PATHS['openai.responses'], body: { ...converted, stream: true }, convert: true }
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
 * One upstream call. Streams call onLine(line) per SSE line. Never throws for upstream/transport
 * failures; returns { ok, status, headers, body?, kernelError?, transportError?, emitted, ttftMs }.
 */
export async function grokUpstreamCall({ cfg, url, token, body, stream, proxyUrl, signal, idleMs, onLine, ops = {} }) {
  const forward = ops.forwardApi || forwardApi
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
      res = await forward({
        cfg,
        method: 'POST',
        url,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        proxyUrl,
        signal: idle.signal,
        stream,
        requireProxy: true,
      })
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
        status: res.kernelError ? (kernelCode === 'proxy_required' ? 503 : 502) : status,
        headers,
        kernelError: !!res.kernelError,
        emitted,
        body: res.kernelError
          ? { error: { type: 'api_error', code: kernelCode, message: `api-kernel: ${kernelCode}` } }
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
          body: { error: { type: 'api_error', code: 'upstream_protocol_error', message: 'upstream returned non-JSON' } },
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
    for (const candidate of picked.candidates || []) {
      const lease = grokRuntime.tryAcquire(candidate.id, {
        concurrency: candidate.concurrency,
        maxRpm: candidate.maxRpm,
        quotaPolicy: livePolicy,
      })
      if (lease) return { picked, vmId: candidate.id, lease }
    }
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

function tokenFailure(code) {
  const status = code === 'grok_oauth_not_configured' ? 503 : code === 'grok_oauth_discovery_failed' ? 502 : 401
  const message =
    code === 'grok_refresh_rejected'
      ? 'Grok 槽位登录已失效，请重新登录'
      : code === 'grok_oauth_not_configured'
        ? 'xAI OAuth 未配置，无法刷新 Grok 令牌'
        : code === 'grok_oauth_discovery_failed'
          ? '读不到 xAI 授权地址，无法刷新 Grok 令牌'
        : 'Grok 槽位没有可用凭证'
  return { ok: false, status, body: { error: { type: 'authentication_error', code, message } } }
}

/**
 * One slot attempt: token, upstream call, a single forced refresh + retry after a 401 that
 * emitted nothing. `onLine` writes to the client; it is only called for 2xx streams.
 */
export async function runGrokSlotHop({
  cfg,
  projectRoot,
  vm,
  routing,
  outbound,
  stream,
  signal,
  onLine,
  ops = {},
}) {
  const proxyUrl = String((ops.hostProxyUrlForVm || hostProxyUrlForVm)(vm) || '')
  if (!proxyUrl) {
    return {
      ok: false,
      status: 503,
      body: { error: { type: 'api_error', code: 'grok_proxy_required', message: 'Grok 槽位没有可用的 SOCKS5 出口' } },
    }
  }
  const ensure = ops.ensureGrokAccessToken || ensureGrokAccessToken
  const url = `${grokBaseUrl(routing)}${outbound.path}`
  const idleMs = idleTimeoutMs(routing)
  let tok = await ensure({ projectRoot, vm, routing, proxyUrl })
  if (!tok.ok) return tokenFailure(tok.code)
  const call = (token) =>
    grokUpstreamCall({ cfg, url, token, body: outbound.body, stream, proxyUrl, signal, idleMs, onLine, ops })
  let result = await call(tok.access_token)
  if (Number(result.status) === 401 && !result.emitted && !result.kernelError && !signal?.aborted) {
    tok = await ensure({ projectRoot, vm, routing, proxyUrl, force: true })
    if (!tok.ok) return { ...tokenFailure(tok.code), refreshed: false }
    result = { ...(await call(tok.access_token)), refreshed: true }
  }
  return result
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
      error: { type: 'invalid_request_error', code: 'protocol_not_allowed', message: `protocol '${protocol}' unsupported` },
    })
  }
  applyOpenaiWashLog(logBag, {
    inboundPath: ctx.path,
    inboundProtocol: protocol,
    converted: outbound.convert,
    outboundBody: outbound.body,
  })
  if (captureOutbound) logBag.outbound_body = outbound.body
  logBag.outbound_headers = redactHeaders({ authorization: 'Bearer ***', 'content-type': 'application/json' })
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
      const bindSticky = () => {
        if (!picked.sessionKey || !stickyRouter?.bind) return
        for (const key of stickyKeys) stickyRouter.bind(key, { accountId: vm.id, vmId: vm.id })
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
        const runHop = () =>
          runGrokSlotHop({
            cfg,
            projectRoot,
            vm,
            routing,
            outbound,
            stream: upstreamStream,
            signal: gone.signal,
            onLine,
            ops,
          })
        let result = await runHop()
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
          result = await runHop()
        }
        if (result?.refreshed) logBag.grok_token_refreshed = true
        logBag.first_token_ms = Number.isFinite(result?.firstTokenAt)
          ? Math.max(0, result.firstTokenAt - requestStartedAt)
          : (result?.ttftMs ?? null)
        ingestGrokHop(projectRoot, vm, result)
        last = result
        if (result?.ok) {
          bindSticky()
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
  return json(res, last?.status || 502, last?.body || { error: { type: 'api_error', code: 'grok_upstream' } })
}

/** No seat was admitted and nothing ran: say which gate stopped the request. */
function rejectGrokAdmission({ res, json, stats, logBag, picked, model }) {
  stats.errors++
  logBag.error_code = picked.error || 'no_grok_vm'
  const fail = (status, type, code, message, extra = {}) => json(res, status, { error: { type, code, message, ...extra } })
  switch (picked.error) {
    case 'platform_mismatch':
      return fail(400, 'invalid_request_error', 'platform_mismatch', `vm '${picked.pin}' is not a Grok slot`)
    case 'key_group_mismatch':
      return fail(403, 'permission_error', 'key_group_mismatch', '此密钥不能调用 xai')
    case 'vm_pool_unavailable':
      return fail(403, 'permission_error', 'vm_pool_unavailable', picked.message || '账号池不可用')
    case 'model_not_allowed':
      return fail(400, 'invalid_request_error', 'model_not_allowed', `model '${model || ''}' is not allowed on any Grok slot`, {
        param: 'model',
      })
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
      return fail(429, 'rate_limit_error', 'pool_overloaded', CLIENT_POOL_BUSY_MESSAGE, { details: { reason: picked.error } })
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
