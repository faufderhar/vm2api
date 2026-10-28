/**
 * Live Grok model list. The slot kernel calls GET /v1/models through the slot
 * exit and attaches the access token. Node never dials Grok Build itself.
 */
import { listVms, getVm } from '../vm/vm-registry.mjs'
import { isGrokVm } from '../vm/vm-kind.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { assertKernelProxyResolved } from '../vm/proxy-policy.mjs'
import { isGrokSeriesId } from './grok-ids.mjs'
import { callGrokKernel, grokKernelEnvelope, readGrokKernelJson } from '../transport/grok-kernel-client.mjs'
import { ensureGrokKernel, writeGrokKernelConfig } from '../transport/grok-kernel-supervisor.mjs'

const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])

/**
 * Effort menu from a /v1/models row, as Grok Build reads it: `reasoning_efforts`
 * (objects with `value`, one marked `default`), else the deprecated
 * `supports_reasoning_effort` flag. Values only; labels stay upstream.
 */
export function liveEffortFields(row) {
  if (!row || typeof row !== 'object') return {}
  const out = {}
  if (Array.isArray(row.reasoning_efforts)) {
    const values = []
    let fallbackDefault = ''
    for (const item of row.reasoning_efforts) {
      const value = String(typeof item === 'string' ? item : item?.value || '')
        .trim()
        .toLowerCase()
      if (!/^[a-z]{1,16}$/.test(value) || values.includes(value)) continue
      values.push(value)
      if (item?.default === true) fallbackDefault = value
    }
    out.reasoning_efforts = values
    const serverDefault = String(row.reasoning_effort_server_default || row.reasoning_effort || fallbackDefault || '')
      .trim()
      .toLowerCase()
    if (values.includes(serverDefault)) out.reasoning_effort_default = serverDefault
  } else if (row.supports_reasoning_effort === false) {
    out.reasoning_efforts = []
  }
  return out
}

export async function fetchGrokUpstreamModels({ projectRoot, vm, forward, readJson = readGrokKernelJson } = {}) {
  const call =
    forward ||
    (async (envelope) => {
      const ready = await ensureGrokKernel({ projectRoot, vmId: vm.id })
      if (!ready?.ok) {
        return { kernelError: true, statusCode: 503, headers: {}, async *[Symbol.asyncIterator]() {} }
      }
      // A JSON document, not a stream: the whole read shares one deadline.
      return callGrokKernel({ projectRoot, vmId: vm.id, envelope, signal: AbortSignal.timeout(60_000) })
    })
  let res
  try {
    res = await call(grokKernelEnvelope({ method: 'GET', path: '/v1/models', purpose: 'models' }))
  } catch (error) {
    return { ok: false, error: 'kernel_unreachable', message: String(error?.message || error).slice(0, 200), ids: [] }
  }
  const payload = await readJson(res).catch(() => null)
  const status = Number(res?.statusCode || res?.status || 0)
  if (res?.kernelError || status >= 400 || !payload) {
    const code = payload?.error?.code || (res?.kernelError ? 'kernel_error' : `http_${status || 0}`)
    return { ok: false, error: code, status, ids: [] }
  }
  const rows = Array.isArray(payload.data) ? payload.data : []
  const ids = []
  const models = []
  for (const row of rows) {
    const id = String(row?.id || '').trim()
    if (!isGrokSeriesId(id) || ids.includes(id)) continue
    ids.push(id)
    models.push({ id, display_name: row?.name || row?.id, ...liveEffortFields(row) })
  }
  return { ok: true, ids, models, status }
}

function grokTargets(projectRoot, vmId = '') {
  const wanted = String(vmId || '').trim()
  return listVms(projectRoot)
    .filter((vm) => vm?.id && isGrokVm(vm) && (!wanted || vm.id === wanted))
    .filter((vm) => !HARD_DOWN.has(String(vm.status || '').toLowerCase()))
    .map((vm) => getVm(projectRoot, vm.id))
    .filter(Boolean)
}

/** One live catalog pull. Does not write the policy; callers decide whether to sync. */
export async function probeGrokModels({ projectRoot, routing, vmId = '' } = {}) {
  const targets = grokTargets(projectRoot, vmId)
  if (!targets.length) return { ok: false, error: 'no_grok_slot', ids: [] }
  let lastError = 'no_token'
  for (const vm of targets) {
    const proxyUrl = hostProxyUrlForVm(vm)
    const localExit = isLocalEgressProxy(vm?.proxy)
    const onNode = !!vm?.node_id
    // Node slots never dial from this host. An empty URL is a missing exit.
    const direct = localExit && !onNode
    if (!proxyUrl && !direct) {
      lastError = 'proxy_required'
      continue
    }
    let kernelProxy = localExit && !onNode ? '' : proxyUrl
    try {
      if (kernelProxy) kernelProxy = await assertKernelProxyResolved(vm, kernelProxy)
      writeGrokKernelConfig(projectRoot, vm, {
        proxyUrl: kernelProxy,
        proxyRequired: !(localExit && !onNode),
        routing,
      })
    } catch (error) {
      if (error?.code !== 'proxy_host_blocked' && error?.code !== 'ipv6_disabled') throw error
      lastError = error.code || 'proxy_host_blocked'
      continue
    }
    const live = await fetchGrokUpstreamModels({
      projectRoot,
      vm,
    })
    if (!live.ok) {
      lastError = live.error || 'models_failed'
      continue
    }
    return { ...live, vm_id: vm.id }
  }
  return { ok: false, error: lastError, ids: [], vm_id: targets[0]?.id || null }
}
