import type { Vm, VmGrokState } from '@/types/panel-vm'

export type VmKind = 'claude' | 'codex' | 'grok'

export type VmPlatform = 'anthropic' | 'openai' | 'xai'

export type PlatformLabel = 'Claude' | 'GPT' | 'Grok'

function labelOf(vm: Vm | undefined, key: 'platform' | 'family' | 'kind') {
  return String(vm?.[key] || '')
    .trim()
    .toLowerCase()
}

export function vmKindOf(vm: Vm | undefined): VmKind {
  if (!vm) return 'claude'
  const platform = labelOf(vm, 'platform')
  const family = labelOf(vm, 'family')
  const kind = labelOf(vm, 'kind')
  if (
    platform === 'xai' ||
    platform === 'grok' ||
    family === 'grok' ||
    kind === 'grok'
  ) {
    return 'grok'
  }
  if (
    platform === 'openai' ||
    family === 'codex' ||
    kind === 'codex' ||
    kind === 'gpt'
  ) {
    return 'codex'
  }
  if (platform === 'anthropic' || family === 'claude' || kind === 'claude') {
    return 'claude'
  }
  if (vm.codex_kernel === true) return 'codex'
  if (String(vm.inference_engine || '').trim() === 'codex') return 'codex'
  if (String(vm.runtime?.codex_kernel || '').trim() === '1') return 'codex'
  return 'claude'
}

export function isCodexVm(vm: Vm | undefined): boolean {
  return vmKindOf(vm) === 'codex'
}

export function isGrokVm(vm: Vm | undefined): boolean {
  return vmKindOf(vm) === 'grok'
}

export function isClaudeVm(vm: Vm | undefined): boolean {
  return vmKindOf(vm) === 'claude'
}

/** 列表视图只带顶层 `grok_*`，详情带完整 `grok` 对象；两处都认。 */
export function grokStateOf(vm: Vm | undefined): VmGrokState {
  const grok: VmGrokState = vm?.grok || {}
  return {
    ...grok,
    auth_error: grok.auth_error ?? vm?.grok_auth_error ?? null,
    limited_until: grok.limited_until ?? vm?.grok_limited_until ?? null,
    limited_reason: grok.limited_reason ?? vm?.grok_limited_reason ?? null,
    build_usage: grok.build_usage ?? vm?.grok_build ?? null,
  }
}

/** Grok Build 周额度，0-100。没有同步结果时为 null，不能当成 0%。 */
export function grokWeeklyUsedPct(vm: Vm | undefined): number | null {
  const value = Number(grokStateOf(vm).build_usage?.credit_usage_percent)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.max(0, Math.min(100, value))
}

/** 月包含额度已用比例。缺月上限或已用金额时为 null。 */
export function grokMonthlyUsedPct(vm: Vm | undefined): number | null {
  const usage = grokStateOf(vm).build_usage
  const limit = Number(usage?.monthly_limit)
  const used = Number(usage?.included_used)
  if (
    !Number.isFinite(limit) ||
    limit <= 0 ||
    !Number.isFinite(used) ||
    used < 0
  ) {
    return null
  }
  return Math.max(0, Math.min(100, (used / limit) * 100))
}

export function grokAuthErrorText(vm: Vm | undefined): string {
  const err = grokStateOf(vm).auth_error
  if (!err) return ''
  const code = String(err.code || '').trim()
  const message = String(err.message || '').trim()
  return [code, message].filter(Boolean).join(' · ') || '授权异常'
}

const KIND_PLATFORM: Record<VmKind, VmPlatform> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
}

export function platformOfKind(kind: VmKind): VmPlatform {
  return KIND_PLATFORM[kind]
}

export function platformOf(vm: Vm | undefined): VmPlatform {
  return KIND_PLATFORM[vmKindOf(vm)]
}

export function platformLabel(vm: Vm | undefined): PlatformLabel {
  return platformLabelOf(vmKindOf(vm))
}

export function platformLabelOf(kind: VmKind): PlatformLabel {
  if (kind === 'codex') return 'GPT'
  if (kind === 'grok') return 'Grok'
  return 'Claude'
}

export function indexVms(vms: Vm[] | undefined | null): Map<string, Vm> {
  const map = new Map<string, Vm>()
  for (const vm of vms || []) {
    if (vm?.id) map.set(vm.id, vm)
  }
  return map
}

/** 没有槽位对象时，用模型名 / 协议猜平台。 */
export function kindFromModel(
  model?: string | null,
  protocol?: string | null
): VmKind {
  const proto = String(protocol || '')
    .trim()
    .toLowerCase()
  if (proto === 'xai' || proto === 'grok') return 'grok'
  if (isGrokCatalogId(String(model || ''))) return 'grok'
  if (
    proto === 'openai' ||
    proto === 'codex' ||
    proto === 'gpt' ||
    proto.includes('openai')
  ) {
    return 'codex'
  }
  if (isGptCatalogId(String(model || ''), proto)) return 'codex'
  return 'claude'
}

/** Account line on rack cards: credential presence is independent of the email. */
export function slotCredentialLabel(
  vm?: Pick<Vm, 'email' | 'has_token' | 'has_refresh'>,
  compact = false
): string {
  const email = String(vm?.email || '').trim()
  if (email) return compact ? email.split('@')[0] : email
  return vm?.has_token || vm?.has_refresh ? '已导入账号 · 邮箱未知' : '空槽'
}

export function slotAccountLabel(
  vm?: Vm,
  fallback?: {
    email?: string | null
    vmId?: string | null
    /** Shown when there is no VM at all, e.g. a request that never got an execution seat. */
    emptyLabel?: string
  }
): string {
  const email = String(vm?.email || fallback?.email || '').trim()
  if (email) return email
  const id = String(fallback?.vmId || vm?.id || '').trim()
  return id || fallback?.emptyLabel || '未绑定账号'
}

/** `vm-01` without an email is unbound. A custom slot id is the name and stays visible. */
export function slotNameLabel(vm?: {
  id?: string | null
  name?: string | null
  email?: string | null
}): string {
  const name = String(vm?.name || vm?.id || '').trim()
  const email = String(vm?.email || '').trim()
  if (email || (name && !/^vm-\d+$/i.test(String(vm?.id || '').trim())))
    return name || '未绑定账号'
  return '未绑定账号'
}

/** 卡片 / 表格用：本地段优先，域名过长只留尾标。完整地址走 title。 */
export function compactEmail(email: string, max = 22): string {
  const value = String(email || '').trim()
  if (!value || value.length <= max) return value
  const at = value.lastIndexOf('@')
  if (at <= 0) return `${value.slice(0, Math.max(1, max - 1))}…`
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  const keepDomain = domain.length <= 12 ? domain : domainTail(domain, 12)
  if (local.length + 1 + keepDomain.length <= max) {
    return `${local}@${keepDomain}`
  }
  const localKeep = Math.max(3, max - keepDomain.length - 2)
  return `${local.slice(0, localKeep)}…@${keepDomain}`
}

function domainTail(domain: string, max: number): string {
  const labels = domain.split('.')
  if (labels.length >= 2) {
    const tail = labels.slice(-2).join('.')
    if (tail.length <= max) return tail
  }
  return `${domain.slice(0, Math.max(1, max - 1))}…`
}

export function isGptCatalogId(id: string, family?: string) {
  const fam = String(family || '')
    .trim()
    .toLowerCase()
  if (fam === 'codex') return true
  return /^gpt/i.test(String(id || '')) && !/^gpt-image/i.test(String(id || ''))
}

export function isGrokCatalogId(id: string, family?: string) {
  const fam = String(family || '')
    .trim()
    .toLowerCase()
  if (fam === 'grok' || fam === 'xai') return true
  return /^grok/i.test(String(id || ''))
}

function catalogKindOf(id: string, family?: string): VmKind {
  if (isGrokCatalogId(id, family)) return 'grok'
  if (isGptCatalogId(id, family)) return 'codex'
  return 'claude'
}

export function catalogForVm<T extends { id: string; family?: string }>(
  items: T[],
  vm: Vm | undefined
): T[] {
  const kind = vmKindOf(vm)
  return items.filter((item) => catalogKindOf(item.id, item.family) === kind)
}
