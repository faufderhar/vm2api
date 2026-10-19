/**
 * Refresh Grok access tokens before they expire. Claude and Codex monitors do not see these slots.
 * One pass every five minutes. A slot with no exit is skipped. Local egress is
 * this machine's own route, so an empty proxy URL is still a bound exit.
 * After the token check, Grok Build billing is synced at most every 15 minutes.
 */
import { isGrokVm } from '../vm/vm-kind.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { ensureGrokAccessToken } from './grok-token.mjs'
import { queryGrokBuildUsage } from './grok-build-usage.mjs'

export const GROK_REFRESH_INTERVAL_MS = 5 * 60 * 1000

export function isGrokRefreshTarget(vm) {
  if (!vm?.id || !isGrokVm(vm)) return false
  const status = String(vm.status || '').toLowerCase()
  if (status === 'stopped' || status === 'dead' || status === 'disabled') return false
  return !!(vm.grok?.has_refresh || vm.has_refresh)
}

export function createGrokRefreshMonitor({
  projectRoot,
  listTargets,
  getRouting,
  proxyUrlFor,
  intervalMs = GROK_REFRESH_INTERVAL_MS,
} = {}) {
  let timer = null
  let inflight = null

  const runOnce = async () => {
    if (inflight) return inflight
    inflight = (async () => {
      const routing = typeof getRouting === 'function' ? getRouting() || {} : {}
      const vms = (typeof listTargets === 'function' ? listTargets() : []) || []
      const items = []
      for (const vm of vms) {
        if (!isGrokRefreshTarget(vm)) continue
        const proxyUrl = typeof proxyUrlFor === 'function' ? proxyUrlFor(vm) : ''
        const local = isLocalEgressProxy(vm.proxy)
        if (!proxyUrl && !local) {
          items.push({ vm_id: vm.id, ok: false, code: 'proxy_required' })
          continue
        }
        const result = await ensureGrokAccessToken({ projectRoot, vm, routing, proxyUrl }).catch((error) => ({
          ok: false,
          code: error?.code || 'grok_refresh_failed',
        }))
        const usage = await queryGrokBuildUsage({
          projectRoot,
          vmId: vm.id,
          routing,
          proxyUrl,
        }).catch((error) => ({ ok: false, error: error?.code || 'grok_build_usage_failed' }))
        const usageFailed = usage.ok === false
        const usageCode = usageFailed ? usage.error || 'grok_build_usage_failed' : null
        const usageState = usageFailed ? 'failed' : 'grok-build'
        items.push({
          vm_id: vm.id,
          ok: !!result.ok && usageState !== 'failed',
          refreshed: !!result.refreshed,
          code: result.code || usageCode,
          usage: usageState,
        })
      }
      return { ok: true, items }
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    runOnce,
    start({ immediate = false } = {}) {
      if (timer) return
      timer = setInterval(() => {
        runOnce().catch((error) => console.warn('[grok-refresh] pass failed', error?.message || error))
      }, Math.max(60_000, Number(intervalMs) || GROK_REFRESH_INTERVAL_MS))
      timer.unref?.()
      if (immediate) {
        queueMicrotask(() => {
          runOnce().catch((error) => console.warn('[grok-refresh] boot pass failed', error?.message || error))
        })
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
