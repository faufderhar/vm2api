import type { VmKernelSnapshot, VmSeedSettings } from '@/types/panel-vm'
import {
  telemetryEnabled,
  telemetrySeedFlags,
  telemetryView,
  type TelemetrySeedFlags,
} from '@/features/vm/telemetry-policy'
import { telemetryStatusLabel } from '@/features/vm/telemetry-status'

export const REJECT_FLAGS = [
  ['reject_client_settings', '拒客户端 settings'],
  ['reject_client_metadata_identity', '拒客户端身份'],
] as const

const TOP_KEYS = ['theme', 'autoUpdates', 'grove_enabled'] as const

/** Env keys rewritten by buildSlotSettingsEnv — editable UI would mislead. */
const READONLY_SEED_ENV_KEYS = new Set([
  'TZ',
  'LANG',
  'LC_ALL',
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_GATEWAY_HINT_HEADERS',
])

export function isReadonlySeedEnvKey(key: string): boolean {
  if (READONLY_SEED_ENV_KEYS.has(key)) return true
  return /GATEWAY_HINT/i.test(key)
}

export function editableSeedEnv(
  env: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isReadonlySeedEnvKey(key)) out[key] = value
  }
  return out
}

export function partitionSeedEnvKeys(env: Record<string, string>): {
  editable: string[]
  readonly: string[]
} {
  const editable: string[] = []
  const readonly: string[] = []
  for (const key of Object.keys(env)) {
    ;(isReadonlySeedEnvKey(key) ? readonly : editable).push(key)
  }
  editable.sort()
  readonly.sort()
  return { editable, readonly }
}

export type SettingRow = {
  key: string
  value: string
  /** True when this env key is also named in the editable claude.setting text. */
  inClaudeSetting: boolean
}

export const SEED_LOCALE_OPTIONS = [
  ['en', 'en_US.UTF-8'],
  ['cn', 'zh_CN.UTF-8'],
  ['jp', 'ja_JP.UTF-8'],
] as const

export const SEED_TIMEZONE_OPTIONS = [
  ['en', 'America/Los_Angeles'],
  ['cn', 'Asia/Shanghai'],
  ['jp', 'Asia/Tokyo'],
] as const

export type SeedSlotContext = {
  timezone?: string | null
  timezone_source?: string | null
  locale?: string | null
}

export type SeedDraft = TelemetrySeedFlags & {
  claude_setting: string
  reject_client_settings: boolean
  reject_client_metadata_identity: boolean
  env: Record<string, string>
  theme: string
  /** True when the slot follows SOCKS5 exit timezone at seed time. */
  timezoneFollow: boolean
  timezoneFixed: string
  locale: string
}

type ObservedTelemetry = NonNullable<VmKernelSnapshot['telemetry']>

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function settingText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : fallback
}

/** Keys named by `KEY=value` lines. Comments and blanks do not count. */
export function claudeSettingKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) keys.add(key)
  }
  return keys
}

export function settingsEnv(
  settings: Record<string, unknown> | null | undefined
): Record<string, string> {
  const env = asRecord(asRecord(settings)?.env) || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = value == null ? '' : String(value)
  }
  if (!('CLAUDE_CODE_ATTRIBUTION_HEADER' in out)) {
    out.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
  }
  return out
}

/**
 * Rows from the slot file `settings.json`. Missing file yields no rows —
 * the policy default string is not a substitute for the file.
 */
export function settingsRows(
  settings: Record<string, unknown> | null | undefined,
  claudeSetting: string
): SettingRow[] {
  const root = asRecord(settings)
  if (!root) return []
  const env = settingsEnv(root)
  const named = claudeSettingKeys(claudeSetting)
  const rows: SettingRow[] = Object.keys(env).map((key) => ({
    key,
    value: env[key],
    inClaudeSetting: named.has(key),
  }))
  for (const key of TOP_KEYS) {
    if (!(key in root)) continue
    rows.push({
      key,
      value: root[key] == null ? '' : String(root[key]),
      inClaudeSetting: false,
    })
  }
  return rows
}

export function seedDraftOf(
  seed: VmSeedSettings | null | undefined,
  slot: SeedSlotContext = {}
): SeedDraft {
  const policy = asRecord(seed?.seed_policy) || {}
  const enabled = telemetryEnabled(policy)
  const env = settingsEnv(seed?.settings_json)
  const manualTz = slot.timezone_source === 'manual'
  const locale =
    String(slot.locale || env.LANG || env.LC_ALL || 'en_US.UTF-8').trim() ||
    'en_US.UTF-8'
  return {
    ...telemetrySeedFlags(enabled),
    claude_setting: settingText(seed?.claude_setting),
    reject_client_settings:
      'reject_client_settings' in policy
        ? policy.reject_client_settings !== false
        : true,
    reject_client_metadata_identity:
      'reject_client_metadata_identity' in policy
        ? policy.reject_client_metadata_identity !== false
        : true,
    env,
    theme:
      typeof asRecord(seed?.settings_json)?.theme === 'string'
        ? String(asRecord(seed?.settings_json)?.theme)
        : typeof policy.theme === 'string'
          ? policy.theme
          : 'dark',
    timezoneFollow: !manualTz,
    timezoneFixed: manualTz
      ? String(slot.timezone || env.TZ || '').trim()
      : String(env.TZ || slot.timezone || '').trim(),
    locale,
  }
}

export function sameDraft(a: SeedDraft, b: SeedDraft): boolean {
  const keys = new Set([...Object.keys(a.env), ...Object.keys(b.env)])
  for (const key of keys) {
    if ((a.env[key] ?? '') !== (b.env[key] ?? '')) return false
  }
  return (
    a.theme === b.theme &&
    a.timezoneFollow === b.timezoneFollow &&
    a.timezoneFixed === b.timezoneFixed &&
    a.locale === b.locale &&
    telemetryEnabled(a) === telemetryEnabled(b) &&
    a.claude_setting === b.claude_setting &&
    a.reject_client_settings === b.reject_client_settings &&
    a.reject_client_metadata_identity === b.reject_client_metadata_identity
  )
}

/** Body for PUT /seed-settings. Mirrors follow the telemetry bit. */
export function seedSaveBody(draft: SeedDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...telemetrySeedFlags(telemetryEnabled(draft)),
    claude_setting: draft.claude_setting.replace(/\n+$/g, ''),
    reject_client_settings: draft.reject_client_settings,
    reject_client_metadata_identity: draft.reject_client_metadata_identity,
    extra_env: editableSeedEnv(draft.env),
    theme: draft.theme,
    locale: draft.locale,
  }
  if (draft.timezoneFollow) body.timezone_follow_proxy = true
  else if (draft.timezoneFixed) body.timezone = draft.timezoneFixed
  return body
}

export type TelemetryLive = {
  on: boolean | null
  running: boolean | null
  label: string
  tone: 'on' | 'off' | 'unknown'
}

/**
 * Live lamp. `running` is the process probe and is never rewritten into
 * on/off. Configured on/off comes from the seed bit when a policy exists.
 */
export function telemetryLive(
  seed: VmSeedSettings | null | undefined,
  observed: ObservedTelemetry | null | undefined
): TelemetryLive {
  const policy = asRecord(seed?.seed_policy)
  const view = telemetryView(policy, observed)
  const enabled = view?.enabled
  const running = observed?.running
  const on = enabled === true ? true : enabled === false ? false : null
  return {
    on,
    running: typeof running === 'boolean' ? running : null,
    label: telemetryStatusLabel(view),
    tone: on === true ? 'on' : on === false ? 'off' : 'unknown',
  }
}
