/**
 * Live xAI model list. The control-plane api-kernel calls GET /v1/models
 * through the slot SOCKS5. Node never dials api.x.ai itself.
 */
import { listVms, getVm } from '../vm/vm-registry.mjs'
import { isGrokVm } from '../vm/vm-kind.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { ensureGrokAccessToken } from '../oauth/grok-token.mjs'
import { grokBaseUrl } from './grok-route.mjs'
import { isGrokSeriesId } from './grok-ids.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'

const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])

export async function fetchGrokUpstreamModels({
  cfg,
  baseUrl,
  token,
  proxyUrl,
  forward = forwardApi,
  readJson = readApiJson,
} = {}) {
  const access = String(token || '').trim()
  if (!access) return { ok: false, error: 'no_token', ids: [] }
  if (!proxyUrl) return { ok: false, error: 'proxy_required', ids: [] }
  const root = String(baseUrl || 'https://api.x.ai').replace(/\/+$/, '')
  let res
  try {
    res = await forward({
      cfg,
      method: 'GET',
      url: `${root}/v1/models`,
      headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
      body: '',
      proxyUrl,
      requireProxy: true,
      timeoutMs: 30_000,
    })
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
    models.push({ id, display_name: row?.name || row?.id })
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
export async function probeGrokModels({ projectRoot, routing, cfg, vmId = '', fetchImpl } = {}) {
  const targets = grokTargets(projectRoot, vmId)
  if (!targets.length) return { ok: false, error: 'no_grok_slot', ids: [] }
  let lastError = 'no_token'
  for (const vm of targets) {
    const proxyUrl = hostProxyUrlForVm(vm)
    if (!proxyUrl) {
      lastError = 'proxy_required'
      continue
    }
    const token = await ensureGrokAccessToken({ projectRoot, vm, routing, proxyUrl, fetchImpl })
    if (!token.ok) {
      lastError = token.code || 'grok_no_credential'
      continue
    }
    const live = await fetchGrokUpstreamModels({
      cfg,
      baseUrl: grokBaseUrl(routing),
      token: token.access_token,
      proxyUrl,
    })
    if (!live.ok) {
      lastError = live.error || 'models_failed'
      continue
    }
    return { ...live, vm_id: vm.id }
  }
  return { ok: false, error: lastError, ids: [], vm_id: targets[0]?.id || null }
}
