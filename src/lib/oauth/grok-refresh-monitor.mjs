/**
 * Grok Build billing for the panel. Claude and Codex monitors do not see these slots.
 * The timer uses the same `usage_probe` interval as Claude usage windows (default
 * 60 seconds); a slot's billing is read again only when its sample is older than
 * GROK_BUILD_USAGE_MIN_STALE_MS, `stale_sec` or `grok.billing.min_interval_sec`,
 * whichever is longest. `grok.billing.background: false` turns the background reads off.
 *
 * Tokens are not refreshed here. The slot kernel refreshes on demand before an
 * upstream call (a billing read included), like the Grok CLI, so an idle account
 * does not see background refresh traffic.
 */
import { isGrokVm } from '../vm/vm-kind.mjs'
import { GROK_BUILD_USAGE_MIN_STALE_MS, queryGrokBuildUsage } from './grok-build-usage.mjs'
import { grokKernelExit } from './grok-kernel-oauth.mjs'
import { normalizeUsageProbeConfig } from './usage-probe-monitor.mjs'
import { grokRoutingOf } from '../protocol/grok-route.mjs'

/** Default check interval. Matches `usage_probe.interval_sec`. */
export const GROK_REFRESH_INTERVAL_MS = normalizeUsageProbeConfig({}).interval_sec * 1000

/** Claude usage-window timer; billing itself is read at most every GROK_BUILD_USAGE_MIN_STALE_MS. */
export function grokUsageProbeTiming(raw = {}) {
  const probe = normalizeUsageProbeConfig(raw)
  return {
    intervalMs: probe.interval_sec * 1000,
    staleMs: Math.max(GROK_BUILD_USAGE_MIN_STALE_MS, probe.stale_sec * 1000),
  }
}

export function isGrokRefreshTarget(vm) {
  if (!vm?.id || !isGrokVm(vm)) return false
  const status = String(vm.status || '').toLowerCase()
  if (status === 'stopped' || status === 'dead' || status === 'disabled') return false
  // The kernel reads billing with whatever token the slot has, refresh token or not.
  return !!(vm.grok?.has_refresh || vm.has_refresh || vm.grok?.has_access || vm.has_token)
}

export function createGrokRefreshMonitor({
  projectRoot,
  listTargets,
  getRouting,
  exitFor = grokKernelExit,
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
      const timed = timing()
      const billing = grokRoutingOf(routing).billing
      // `grok.billing.background: false` stops the timer's reads; the panel refresh button still works.
      if (!billing.background) return { ok: true, disabled: true, items: [] }
      const schedule =
        timed.staleMs == null ? timed : { ...timed, staleMs: Math.max(timed.staleMs, billing.min_interval_sec * 1000) }
      const vms = (typeof listTargets === 'function' ? listTargets() : []) || []
      const items = []
      for (const vm of vms) {
        if (!isGrokRefreshTarget(vm)) continue
        if (!exitFor(vm)) {
          items.push({ vm_id: vm.id, ok: false, code: 'proxy_required' })
          continue
        }
        const usage = await queryGrokBuildUsage({
          projectRoot,
          vmId: vm.id,
          routing,
          staleMs: schedule.staleMs,
        }).catch((error) => ({ ok: false, error: error?.code || 'grok_build_usage_failed' }))
        const usageFailed = usage.ok === false
        items.push({
          vm_id: vm.id,
          ok: !usageFailed,
          skipped: usage.skipped === true,
          code: usageFailed ? usage.error || 'grok_build_usage_failed' : null,
          usage: usageFailed ? 'failed' : 'grok-build',
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
