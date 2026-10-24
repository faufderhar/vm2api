/**
 * auth.x.ai calls for one Grok slot, sent by that slot's kin-grok-kernel.
 * Login, device-code polling, PKCE exchange and refresh all leave through the
 * same client and exit as inference, so xAI sees one Grok client per account.
 * Node never talks to auth.x.ai itself.
 */
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { assertKernelProxyResolved } from '../vm/proxy-policy.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { ensureGrokKernel, writeGrokKernelConfig } from '../transport/grok-kernel-supervisor.mjs'
import { callGrokKernel, readGrokKernelJson } from '../transport/grok-kernel-client.mjs'

const OAUTH_CALL_TIMEOUT_MS = 45_000

/**
 * Kernel exit for a slot. A control-plane slot on local egress dials directly
 * (proxy_url empty, not required). A node slot always goes through the node's
 * forwarder. null when the slot has no usable exit.
 */
export function grokKernelExit(vm, { hostProxyUrl = hostProxyUrlForVm } = {}) {
  const local = isLocalEgressProxy(vm?.proxy)
  const onNode = !!vm?.node_id
  if (local && !onNode) return { proxyUrl: '', proxyRequired: false }
  let proxyUrl = ''
  try {
    proxyUrl = String(hostProxyUrl(vm) || '')
  } catch {
    return null
  }
  return proxyUrl ? { proxyUrl, proxyRequired: true } : null
}

/**
 * `transport({ action, form, force })` for grok-oauth.mjs and grok-token.mjs.
 * Resolves `{ status, payload }` for device_authorize / token, the kernel's JSON for
 * refresh, or `{ error, status: 0 }` when the kernel or its exit failed.
 */
export function grokKernelOauthTransport({ projectRoot, vm, routing = {}, ops = {} } = {}) {
  return async ({ action, form = {}, force = false } = {}) => {
    const exit = (ops.grokKernelExit || grokKernelExit)(vm)
    if (!exit) return { status: 0, error: 'proxy_required' }
    const write = ops.writeGrokKernelConfig || writeGrokKernelConfig
    let proxyUrl = exit.proxyUrl
    if (proxyUrl && write === writeGrokKernelConfig) {
      try {
        proxyUrl = await assertKernelProxyResolved(vm, proxyUrl)
      } catch (error) {
        return { status: 0, error: error?.code || 'proxy_required' }
      }
    }
    try {
      write(projectRoot, vm, { ...exit, proxyUrl, routing })
    } catch (error) {
      return { status: 0, error: error?.code || 'proxy_required' }
    }
    const ready = await (ops.ensureGrokKernel || ensureGrokKernel)({ projectRoot, vmId: vm.id })
    if (!ready?.ok) return { status: 0, error: 'grok_kernel_unavailable' }
    let res
    try {
      res = await (ops.callGrokKernel || callGrokKernel)({
        projectRoot,
        vmId: vm.id,
        endpoint: '/internal/oauth',
        envelope: { action, form, force: force === true },
        signal: AbortSignal.timeout(OAUTH_CALL_TIMEOUT_MS),
      })
    } catch (error) {
      const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
      return { status: 0, error: aborted ? 'timeout' : 'grok_kernel_unavailable' }
    }
    const body = await readGrokKernelJson(res).catch(() => null)
    if (res.kernelError || Number(res.statusCode) >= 400) {
      return { status: 0, error: String(body?.error?.code || 'grok_kernel_unavailable') }
    }
    if (action === 'refresh') return { status: 200, payload: body }
    return { status: Number(body?.status) || 0, payload: body?.body ?? null }
  }
}
