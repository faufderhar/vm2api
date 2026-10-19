/**
 * Grok catalog. Settings key `grok_model_policy`, separate from Claude and GPT.
 * The seed is empty: prices and ids come from a live /v1/models sync, not a guessed list.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { isGrokSeriesId } from './grok-ids.mjs'

const SETTINGS_KEY = 'grok_model_policy'

const CAP_GROK = {
  context_window: 131072,
  supports_1m: false,
  thinking_mode: 'enabled_only',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: false,
  supports_context_management: false,
}

function entry(id, extra = {}) {
  return {
    id,
    display_name: extra.display_name || extra.label || id,
    family: 'grok',
    enabled: extra.enabled !== false,
    sort: extra.sort || 80,
    capabilities: extra.capabilities || { ...CAP_GROK },
    params: extra.params || { max_tokens_default: 16384, max_tokens_cap: 128000 },
    aliases: extra.aliases || [],
  }
}

export function seedGrokPolicy() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: 'seed',
    platform: 'xai',
    models: {},
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
      for (const [id, row] of Object.entries(stored.models)) {
        if (!isGrokSeriesId(id) || !row || typeof row !== 'object') continue
        models[id] = entry(id, row)
      }
      policy = { ...seedGrokPolicy(), ...stored, models, platform: 'xai', source: stored.source || 'settings' }
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
      models[id] = entry(id, { ...row, enabled: row.enabled !== false })
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

/** True when this id may be scheduled. An empty seed allows any grok chat id until a live sync. */
export function isGrokCatalogModel(id) {
  if (!isGrokSeriesId(id)) return false
  if (!loaded) loadGrokModelPolicy()
  const row = policy.models?.[id]
  if (row) return row.enabled !== false
  if (policy.source === 'xai' && Object.keys(policy.models || {}).length) return false
  return true
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
    live.push({
      id,
      display_name: String((typeof item === 'object' && (item.display_name || item.name)) || '').trim(),
    })
  }
  if (!live.length) {
    return { ok: true, synced: 0, added: [], ids: listGrokPolicyModels().map((row) => row.id) }
  }
  const next = {}
  const added = []
  for (const row of live) {
    const prev = policy.models[row.id]
    if (!prev) added.push(row.id)
    next[row.id] = entry(row.id, {
      ...prev,
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
