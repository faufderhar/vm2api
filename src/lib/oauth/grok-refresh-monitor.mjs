/**
 * Refresh Grok access tokens before they expire. Claude and Codex monitors do not see these slots.
 * The timer uses the same `usage_probe` interval as Claude usage windows
 * (default 60 seconds). Billing is fetched again only after `stale_sec`
 * (default 5 minutes). A slot with no exit is skipped. Local egress is
 * this machine's own route, so an empty proxy URL is still a bound exit.
 */
import { isGrokVm } from '../vm/vm-kind.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { ensureGrokAccessToken } from './grok-token.mjs'
import { queryGrokBuildUsage } from './grok-build-usage.mjs'
import { normalizeUsageProbeConfig } from './usage-probe-monitor.mjs'

/** Default check interval. Matches `usage_probe.interval_sec`. */
export const GROK_REFRESH_INTERVAL_MS = normalizeUsageProbeConfig({}).interval_sec * 1000

/** Claude usage-window cadence. Grok has no response-header sample, so it keeps polling. */
export function grokUsageProbeTiming(raw = {}) {
  const probe = normalizeUsageProbeConfig(raw)
  return {
    intervalMs: probe.interval_sec * 1000,
    staleMs: probe.stale_sec * 1000,
  }
}

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
  getUsageProbe,
  intervalMs = GROK_REFRESH_INTERVAL_MS,
} = {}) {
  let timer = null
  let inflight = null
  const timing = () => {
    if (typeof getUsageProbe === 'function') return grokUsageProbeTiming(getUsageProbe())
    return { intervalMs: Math.max(30_000, Number(intervalMs) || GROK_REFRESH_INTERVAL_MS), staleMs: undefined }
  }

  const runOnce = async () => {
    if (inflight) return inflight
    inflight = (async () => {
      const routing = typeof getRouting === 'function' ? getRouting() || {} : {}
      const schedule = timing()
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
          staleMs: schedule.staleMs,
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
      const arm = () => {
        if (timer) clearInterval(timer)
        timer = setInterval(() => {
          runOnce().catch((error) => console.warn('[grok-refresh] pass failed', error?.message || error))
        }, timing().intervalMs)
        timer.unref?.()
      }
      arm()
      timer.unref?.()
      if (immediate) {
        queueMicrotask(() => {
          runOnce().catch((error) => console.warn('[grok-refresh] boot pass failed', error?.message || error))
        })
      }
    },
    /** Follow a saved Claude usage-window interval without waiting for a restart. */
    setUsageProbe() {
      if (!timer) return timing()
      if (timer) clearInterval(timer)
      timer = null
      this.start({ immediate: false })
      return timing()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
