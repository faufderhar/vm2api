export type Pass1mMode = 'true' | 'false' | 'inherit'
export type BetaFilter = 'all' | 'pass' | 'strip' | 'inherit'
export type CatalogMode =
  'worker_intersect_policy' | 'worker_only' | 'policy_only'

export type ModelCaps = {
  context_window?: number
  supports_1m?: boolean
  supports_adaptive?: boolean
  supports_effort?: boolean
  thinking_mode?: string
}

export type ModelParams = {
  on_adaptive?: string
  on_enabled?: string
  thinking_fallback_budget?: number
  max_tokens_default?: number
  max_tokens_cap?: number
}

export type ModelBetas = {
  required?: string[]
  drop?: string[]
  allow_client?: boolean
  pass_context_1m?: boolean
}

export type ModelEntry = {
  id: string
  enabled?: boolean
  display_name?: string
  family?: string
  sort?: number
  aliases?: string[]
  capabilities?: ModelCaps
  params?: ModelParams
  betas?: ModelBetas
}

export type PolicyDefaults = {
  strip_context_1m?: boolean
  normalize_thinking?: boolean
  thinking_fallback_budget?: number
  max_tokens?: number
  context_1m_whitelist?: string[]
}

export type ModelPolicy = {
  version?: number
  updated_at?: string
  source?: string
  catalog_mode?: string
  defaults?: PolicyDefaults
  models?: Record<string, Omit<ModelEntry, 'id'>>
  aliases?: Record<string, string>
}

export type PolicyPayload = {
  policy?: ModelPolicy
  models?: { id: string }[]
  effective?: { id: string }[]
  synced?: number
}

const DEFAULT_WHITELIST = ['claude-sonnet-5', 'claude-sonnet-5-*']

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function emptyPolicy(): ModelPolicy {
  return {
    catalog_mode: 'worker_intersect_policy',
    defaults: {
      context_1m_whitelist: [...DEFAULT_WHITELIST],
    },
    models: {},
  }
}

export function hydratePolicy(raw: unknown): ModelPolicy {
  const pol =
    raw && typeof raw === 'object'
      ? cloneJson(raw as ModelPolicy)
      : emptyPolicy()
  pol.defaults = pol.defaults || {}
  if (!Array.isArray(pol.defaults.context_1m_whitelist)) {
    pol.defaults.context_1m_whitelist = [...DEFAULT_WHITELIST]
  }
  pol.models = pol.models || {}
  for (const rec of Object.values(pol.models)) {
    if (!rec || typeof rec !== 'object') continue
    rec.params = rec.params || {}
    if (rec.params.on_enabled === 'convert_to_adaptive') {
      rec.params.on_enabled = 'passthrough'
    }
    rec.betas = rec.betas || {}
    // 不把未设置的 pass_context_1m 坍缩成 boolean。
  }
  if (!pol.catalog_mode) pol.catalog_mode = 'worker_intersect_policy'
  return pol
}

export function listModelEntries(pol: ModelPolicy): ModelEntry[] {
  return Object.entries(pol.models || {})
    .map(([id, rec]) => ({ id, ...rec }))
    .sort(
      (a, b) =>
        (a.sort ?? 100) - (b.sort ?? 100) ||
        String(a.id).localeCompare(String(b.id))
    )
}

export function context1mWhitelist(pol: ModelPolicy): string[] {
  const list = pol.defaults?.context_1m_whitelist
  return Array.isArray(list) && list.length ? list : [...DEFAULT_WHITELIST]
}

export function matchContext1mPattern(pattern: string, model: string): boolean {
  const p = pattern.trim().toLowerCase()
  if (!p) return false
  const parts = model.trim().split('/').filter(Boolean)
  const m = parts[parts.length - 1] || ''
  const bare = m.replace(/(\[1m\])+$/i, '').toLowerCase()
  if (p.endsWith('*')) return bare.startsWith(p.slice(0, -1))
  return bare === p
}

export function passContext1mMode(m: ModelEntry): Pass1mMode {
  const v = m.betas?.pass_context_1m
  if (v === true) return 'true'
  if (v === false) return 'false'
  return 'inherit'
}

export function passContext1mEffective(
  m: ModelEntry,
  pol: ModelPolicy
): boolean {
  if (typeof m.betas?.pass_context_1m === 'boolean')
    return m.betas.pass_context_1m
  return context1mWhitelist(pol).some((p) => matchContext1mPattern(p, m.id))
}

export function contextWindowLabel(m: ModelEntry): {
  text: string
  native1m: boolean
} {
  const caps = m.capabilities || {}
  const win = Number(caps.context_window || 0)
  if (win > 0) {
    const million = win >= 1_000_000
    return {
      text: million ? '1M' : `${Math.floor(win / 1000)}K`,
      native1m: million,
    }
  }
  const native1m = !!caps.supports_1m
  const text = native1m ? '1M' : '0K'
  return { text, native1m }
}

export function thinkingPolicyLabel(m: ModelEntry): string {
  const params = m.params || {}
  const caps = m.capabilities || {}
  const en = params.on_enabled || 'passthrough'
  const ad =
    params.on_adaptive ||
    (caps.supports_adaptive ? 'passthrough' : 'convert_to_enabled')
  if (en === 'convert_to_adaptive') return 'enabled→adaptive'
  if (ad === 'convert_to_enabled') return 'adaptive→enabled'
  if (en === 'strip' || ad === 'strip') return '剥离'
  return '透传'
}

export function filterModels(
  all: ModelEntry[],
  pol: ModelPolicy,
  q: string,
  family: string,
  beta: BetaFilter
): ModelEntry[] {
  const needle = q.trim().toLowerCase()
  return all.filter((m) => {
    if (family !== 'all' && String(m.family || '').toLowerCase() !== family) {
      return false
    }
    if (beta === 'pass' && !passContext1mEffective(m, pol)) return false
    if (beta === 'strip' && passContext1mEffective(m, pol)) return false
    if (beta === 'inherit' && passContext1mMode(m) !== 'inherit') return false
    if (!needle) return true
    const hay = [m.id, m.display_name, m.family, ...(m.aliases || [])]
      .join(' ')
      .toLowerCase()
    return hay.includes(needle)
  })
}

export function familyOptions(all: ModelEntry[]): string[] {
  const set = new Set<string>()
  for (const m of all) set.add(String(m.family || 'other').toLowerCase())
  return ['all', ...[...set].sort()]
}

export function policyStats(
  all: ModelEntry[],
  pol: ModelPolicy,
  effectiveIds: Set<string>
): { configured: number; enabled: number; live: number; pass1m: number } {
  return {
    configured: all.length,
    enabled: all.filter((m) => m.enabled !== false).length,
    live: effectiveIds.size,
    pass1m: all.filter((m) => passContext1mEffective(m, pol)).length,
  }
}

export function applyPassContext1m(
  rec: Omit<ModelEntry, 'id'>,
  mode: Pass1mMode
): void {
  rec.betas = rec.betas || {}
  if (mode === 'inherit') {
    delete rec.betas.pass_context_1m
    return
  }
  rec.betas.pass_context_1m = mode === 'true'
}

export function isCatalogMode(v: string | undefined): v is CatalogMode {
  return (
    v === 'worker_intersect_policy' ||
    v === 'worker_only' ||
    v === 'policy_only'
  )
}
