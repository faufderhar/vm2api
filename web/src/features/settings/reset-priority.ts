/**
 * 「优先使用临近重置的账号」面板读数，与后端 src/lib/pool/reset-priority.mjs 一致。
 * 三家各存两项平铺字段：reset_priority（默认开）与 reset_priority_idle_sec（秒）。
 */
type Block = Record<string, unknown>

export const RESET_IDLE_LIMITS = { min: 60, max: 86400 } as const
/** Codex / Grok：沿用会话窗口的 5 分钟空闲判定。 */
export const RESET_IDLE_DEFAULT_SEC = 300
/** Claude：默认 cache_control ttl 1 小时，空闲满 1 小时提示缓存已失效。 */
export const CLAUDE_RESET_IDLE_DEFAULT_SEC = 3600
/** 预设档位（秒）。 */
export const RESET_IDLE_STEPS = [300, 900, 1800, 3600, 7200] as const

export type ResetPriorityView = { enabled: boolean; idleSec: number }

export function resetPriorityView(
  block: Block,
  fallbackSec: number = RESET_IDLE_DEFAULT_SEC
): ResetPriorityView {
  const raw = block.reset_priority_idle_sec
  const n = Number(raw)
  const idleSec =
    raw == null || raw === '' || !Number.isFinite(n)
      ? fallbackSec
      : Math.min(
          RESET_IDLE_LIMITS.max,
          Math.max(RESET_IDLE_LIMITS.min, Math.round(n))
        )
  return { enabled: block.reset_priority !== false, idleSec }
}

export function fmtIdle(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600} 小时`
  if (sec % 60 === 0) return `${sec / 60} 分钟`
  return `${sec} 秒`
}

/** 预设档位加上当前值（若不在预设里），按时长排序。 */
export function resetIdleOptions(current: number): [number, string][] {
  const values = new Set<number>([...RESET_IDLE_STEPS, current])
  return [...values].sort((a, b) => a - b).map((sec) => [sec, fmtIdle(sec)])
}
