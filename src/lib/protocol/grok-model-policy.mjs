/**
 * Grok catalog. Settings key `grok_model_policy`, separate from Claude and GPT.
 * Seed lists the published chat models. A live /v1/models sync replaces that list.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { isGrokSeriesId } from './grok-ids.mjs'

const SETTINGS_KEY = 'grok_model_policy'

const LEGACY_CONTEXT_WINDOW = 131072
/** 200k is the long-context price threshold, not a Grok chat window. */
const STALE_CONTEXT_WINDOWS = new Set([LEGACY_CONTEXT_WINDOW, 200_000])

/** Published context windows (docs.x.ai/developers/models.md). Unknown chat ids stay at 500k. */
const GROK_CONTEXT = [
  [/^grok-4\.(?:5|6|7)(?:-|$)/i, 500_000],
  [/^grok-4\.3(?:-|$)/i, 1_000_000],
  [/^grok-4\.20(?:-|$)/i, 1_000_000],
  [/^grok-build-/i, 256_000],
]

const GROK_SEED = [
  ['grok-4.7', { display_name: 'Grok 4.7', sort: 70 }],
  ['grok-4.6', { display_name: 'Grok 4.6', sort: 71 }],
  ['grok-4.5', { display_name: 'Grok 4.5', sort: 72 }],
  ['grok-4.3', { display_name: 'Grok 4.3', sort: 80 }],
  ['grok-4.20-0309-reasoning', { display_name: 'Grok 4.20 Reasoning', sort: 81 }],
  ['grok-4.20-0309-non-reasoning', { display_name: 'Grok 4.20', sort: 82 }],
  ['grok-4.20-multi-agent-0309', { display_name: 'Grok 4.20 Multi-Agent', sort: 83 }],
  ['grok-build-0.1', { display_name: 'Grok Build 0.1', sort: 90 }],
]

function grokContextWindow(id) {
  const found = GROK_CONTEXT.find(([pattern]) => pattern.test(id))
  return found ? found[1] : 500_000
}

function grokCapabilities(id, extra = {}) {
  const window = grokContextWindow(id)
  return {
    context_window: window,
    supports_1m: window >= 1_000_000,
    thinking_mode: 'enabled_only',
    supports_adaptive: false,
    requires_adaptive: false,
    supports_interleaved: false,
    supports_effort: /^grok-4\.(?:5|6|7)(?:-|$)/i.test(id),
    supports_context_management: false,
    ...extra,
  }
}

/**
 * Fill missing caps from the published window.
 * 128k and 200k used to be stored by mistake (old default, or Claude's long-context
 * price threshold). Those unmarked rows are upgraded once.
 * A panel save sets context_window_custom so the same numbers stay if an admin chose them.
 */
function withKnownCaps(id, capabilities, { trustWindow = false } = {}) {
  const known = grokCapabilities(id)
  if (!capabilities || typeof capabilities !== 'object') return known
  const window = Number(capabilities.context_window)
  const explicit = trustWindow || capabilities.context_window_custom === true
  const invalid = !Number.isFinite(window) || window <= 0
  const legacyDefault = STALE_CONTEXT_WINDOWS.has(window) && window !== known.context_window
  const replace = invalid || (!explicit && legacyDefault)
  const contextWindow = replace ? known.context_window : window
  const custom = !replace && explicit && contextWindow !== known.context_window
  const caps = {
    ...known,
    ...capabilities,
    context_window: contextWindow,
    supports_1m: explicit || replace ? contextWindow >= 1_000_000 : capabilities.supports_1m === true,
    supports_effort: capabilities.supports_effort === true || known.supports_effort,
  }
  if (custom) caps.context_window_custom = true
  else delete caps.context_window_custom
  return caps
}

function entry(id, extra = {}, options = {}) {
  return {
    id,
    display_name: extra.display_name || extra.label || id,
    family: 'grok',
    enabled: extra.enabled !== false,
    sort: extra.sort || 80,
    capabilities: withKnownCaps(id, extra.capabilities, options),
    params: extra.params || { max_tokens_default: 16384, max_tokens_cap: 128000 },
    aliases: extra.aliases || [],
  }
}

export function seedGrokPolicy() {
  const models = {}
  for (const [id, extra] of GROK_SEED) models[id] = entry(id, extra)
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: 'seed',
    platform: 'xai',
    models,
  }
}

let policy = seedGrokPolicy()
let loaded = false

function persist() {
  try {
    new SettingsRepo().set(SETTINGS_KEY, policy)
  } catch (error) {
    console.warn('[grok-model-policy] persist failed', error?.message || error)
  }
}

export function loadGrokModelPolicy({ force = false } = {}) {
  if (loaded && !force) return policy
  try {
    const stored = new SettingsRepo().get(SETTINGS_KEY, null)
    if (stored && typeof stored === 'object' && stored.models && typeof stored.models === 'object') {
      const models = {}
      let repaired = false
      for (const [id, row] of Object.entries(stored.models)) {
        if (!isGrokSeriesId(id) || !row || typeof row !== 'object') continue
        models[id] = entry(id, row)
        const storedWindow = Number(row.capabilities?.context_window)
        if (models[id].capabilities.context_window !== storedWindow) repaired = true
      }
      const live = stored.source === 'xai' && Object.keys(models).length > 0
      policy = {
        ...(live
          ? { ...seedGrokPolicy(), ...stored, models }
          : { ...seedGrokPolicy(), ...stored, models: { ...seedGrokPolicy().models, ...models } }),
        platform: 'xai',
        source: stored.source || 'settings',
      }
      if (repaired) persist()
    } else {
      policy = seedGrokPolicy()
      persist()
    }
  } catch {
    policy = seedGrokPolicy()
  }
  loaded = true
  return policy
}

export function getGrokModelPolicy() {
  if (!loaded) loadGrokModelPolicy()
  return policy
}

export function saveGrokModelPolicy(next) {
  const models = {}
  if (next?.models && typeof next.models === 'object') {
    for (const [id, row] of Object.entries(next.models)) {
      if (!isGrokSeriesId(id) || !row || typeof row !== 'object') continue
      models[id] = entry(id, { ...row, enabled: row.enabled !== false }, { trustWindow: true })
    }
  }
  policy = {
    ...seedGrokPolicy(),
    ...next,
    models,
    platform: 'xai',
    updated_at: new Date().toISOString(),
    source: 'panel',
  }
  loaded = true
  persist()
  return policy
}

export function listGrokPolicyModels() {
  if (!loaded) loadGrokModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGrokSeriesId(id) && cfg?.enabled !== false)
    .map(([id, cfg]) => ({ id, ...cfg, family: 'grok' }))
    .sort((a, b) => (a.sort || 80) - (b.sort || 80) || String(a.id).localeCompare(String(b.id)))
}

/** Ids the price catalog should attach, including models that are turned off. */
export function getGrokPolicyCatalogIds({ enabledOnly = false } = {}) {
  if (!loaded) loadGrokModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGrokSeriesId(id) && (!enabledOnly || cfg?.enabled !== false))
    .map(([id]) => id)
}

/** True when this id may be scheduled. An empty seed allows any grok chat id until a live sync. */
export function isGrokCatalogModel(id) {
  if (!isGrokSeriesId(id)) return false
  if (!loaded) loadGrokModelPolicy()
  const row = policy.models?.[id]
  if (row) return row.enabled !== false
  if (policy.source === 'xai' && Object.keys(policy.models || {}).length) return false
  return true
}

/**
 * Model id to send upstream for a request: `provider/` prefix dropped, panel alias resolved.
 * A row the panel turned off is refused. An id the policy has never seen still goes to xAI,
 * so a model shipped between catalog syncs keeps working; xAI rejects it if it is not real.
 */
export function resolveGrokRequestModel(raw) {
  const requested = String(raw || '').trim()
  const bare = requested.split('/').filter(Boolean).pop() || requested
  if (!loaded) loadGrokModelPolicy()
  const models = policy.models || {}
  let id = bare
  if (!models[id]) {
    const wanted = bare.toLowerCase()
    const hit = Object.entries(models).find(([, row]) =>
      (Array.isArray(row?.aliases) ? row.aliases : []).some((alias) => String(alias).trim().toLowerCase() === wanted),
    )
    if (hit) id = hit[0]
  }
  const row = models[id]
  if (row && row.enabled === false) return { ok: false, code: 'model_disabled', model: id, requested }
  return { ok: true, model: id, alias: id !== bare ? bare : null, requested }
}

/**
 * Effort values xAI listed for this model on the last live sync, or null when the
 * catalog never said (seed rows, older syncs). The convert path falls back to its
 * static table on null.
 */
export function grokReasoningEffortsFor(model) {
  const resolved = resolveGrokRequestModel(model)
  if (!loaded) loadGrokModelPolicy()
  const list = policy.models?.[resolved.model]?.capabilities?.reasoning_efforts
  return Array.isArray(list) ? list.slice() : null
}

export function resetGrokModelPolicy() {
  policy = seedGrokPolicy()
  loaded = true
  persist()
  return policy
}

/**
 * Replace the catalog with the live xAI list. Existing rows keep their edits.
 * An id the policy has never seen starts disabled until an admin enables it.
 */
export function syncGrokIdsIntoPolicy(ids = [], { displayNameOf = null } = {}) {
  if (!loaded) loadGrokModelPolicy()
  const live = []
  const seen = new Set()
  for (const item of ids || []) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim()
    if (!isGrokSeriesId(id) || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    const row = {
      id,
      display_name: String((typeof item === 'object' && (item.display_name || item.name)) || '').trim(),
    }
    if (typeof item === 'object' && Array.isArray(item.reasoning_efforts)) {
      row.reasoning_efforts = item.reasoning_efforts.map((value) => String(value))
      if (item.reasoning_effort_default) row.reasoning_effort_default = String(item.reasoning_effort_default)
    }
    live.push(row)
  }
  if (!live.length) {
    return { ok: true, synced: 0, added: [], ids: listGrokPolicyModels().map((row) => row.id) }
  }
  const next = {}
  const added = []
  for (const row of live) {
    const prev = policy.models[row.id]
    if (!prev) added.push(row.id)
    const capabilities = { ...(prev?.capabilities || {}) }
    if (row.reasoning_efforts) {
      capabilities.reasoning_efforts = row.reasoning_efforts
      if (row.reasoning_effort_default) capabilities.reasoning_effort_default = row.reasoning_effort_default
      else delete capabilities.reasoning_effort_default
    }
    next[row.id] = entry(row.id, {
      ...prev,
      capabilities: prev || row.reasoning_efforts ? capabilities : undefined,
      display_name: row.display_name || prev?.display_name || displayNameOf?.(row.id) || row.id,
      enabled: prev ? prev.enabled !== false : false,
    })
  }
  policy = {
    ...policy,
    models: next,
    platform: 'xai',
    updated_at: new Date().toISOString(),
    source: 'xai',
  }
  loaded = true
  persist()
  return { ok: true, synced: live.length, added, ids: listGrokPolicyModels().map((row) => row.id) }
}

export function resetGrokModelPolicyForTests() {
  policy = seedGrokPolicy()
  loaded = false
}
