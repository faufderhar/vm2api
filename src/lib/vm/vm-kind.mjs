/**
 * One VM holds one credential kind.
 * platform/family is the source of truth; Claude inference is rust-only.
 */

export const VM_KIND_CLAUDE = 'claude'
export const VM_KIND_CODEX = 'codex'
export const VM_KIND_GROK = 'grok'

export const PLATFORM_ANTHROPIC = 'anthropic'
export const PLATFORM_OPENAI = 'openai'
export const PLATFORM_XAI = 'xai'

/** Per-kind facts. Callers switch on these instead of assuming "not Codex = Claude". */
export const PLATFORMS = Object.freeze({
  [VM_KIND_CLAUDE]: Object.freeze({
    platform: PLATFORM_ANTHROPIC,
    family: 'claude',
    kind: VM_KIND_CLAUDE,
    label: 'Claude',
    groupType: PLATFORM_ANTHROPIC,
    role: null,
    credFile: null,
  }),
  [VM_KIND_CODEX]: Object.freeze({
    platform: PLATFORM_OPENAI,
    family: 'codex',
    kind: VM_KIND_CODEX,
    label: 'GPT',
    groupType: PLATFORM_OPENAI,
    role: 'codex',
    credFile: 'codex-credentials.json',
  }),
  [VM_KIND_GROK]: Object.freeze({
    platform: PLATFORM_XAI,
    family: 'grok',
    kind: VM_KIND_GROK,
    label: 'Grok',
    groupType: PLATFORM_XAI,
    role: 'grok',
    credFile: 'grok-credentials.json',
  }),
})

const PLATFORM_TO_KIND = Object.freeze({
  [PLATFORM_ANTHROPIC]: VM_KIND_CLAUDE,
  [PLATFORM_OPENAI]: VM_KIND_CODEX,
  [PLATFORM_XAI]: VM_KIND_GROK,
})

function labelOf(vm, key) {
  return String(vm?.[key] || '')
    .trim()
    .toLowerCase()
}

function isCodexLabel(value) {
  return value === 'openai' || value === 'codex' || value === 'gpt' || value === 'chatgpt'
}

function isGrokLabel(value) {
  return value === 'xai' || value === 'x.ai' || value === 'grok'
}

function isClaudeLabel(value) {
  return value === 'anthropic' || value === 'claude'
}

function kindResult(kind) {
  const d = PLATFORMS[kind]
  return { platform: d.platform, family: d.family, kind: d.kind }
}

/** Platform label from free-form input (`grok`, `gpt`, `claude`, ...). Empty when unknown. */
export function normalizePlatformLabel(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
  if (isCodexLabel(v)) return PLATFORM_OPENAI
  if (isGrokLabel(v)) return PLATFORM_XAI
  if (isClaudeLabel(v)) return PLATFORM_ANTHROPIC
  return ''
}

/**
 * Resolve credential kind. Explicit platform/family/kind win.
 * Unmarked VMs fall back to legacy Codex flags, otherwise Claude.
 */
export function normalizeVmKind(vm = {}) {
  const src = vm && typeof vm === 'object' ? vm : {}
  const platform = labelOf(src, 'platform')
  const family = labelOf(src, 'family')
  const kind = labelOf(src, 'kind') || labelOf(src, 'credential_kind')
  if (isCodexLabel(platform) || isCodexLabel(family) || isCodexLabel(kind)) return kindResult(VM_KIND_CODEX)
  if (isGrokLabel(platform) || isGrokLabel(family) || isGrokLabel(kind)) return kindResult(VM_KIND_GROK)
  if (isClaudeLabel(platform) || isClaudeLabel(family) || isClaudeLabel(kind)) return kindResult(VM_KIND_CLAUDE)
  if (src.codex_kernel === true) return kindResult(VM_KIND_CODEX)
  if (labelOf(src, 'inference_engine') === 'codex') return kindResult(VM_KIND_CODEX)
  if (String(src.runtime?.codex_kernel || '').trim() === '1') return kindResult(VM_KIND_CODEX)
  return kindResult(VM_KIND_CLAUDE)
}

/** 'anthropic' | 'openai' | 'xai' */
export function platformOf(vm = {}) {
  return normalizeVmKind(vm).platform
}

/** Descriptor for a VM, a kind ('grok') or a platform ('xai'). Unknown strings resolve to Claude. */
export function platformDescriptor(vmOrLabel) {
  if (typeof vmOrLabel === 'string') {
    const v = vmOrLabel.trim().toLowerCase()
    if (PLATFORMS[v]) return PLATFORMS[v]
    const p = normalizePlatformLabel(v)
    return PLATFORMS[PLATFORM_TO_KIND[p] || VM_KIND_CLAUDE]
  }
  return PLATFORMS[normalizeVmKind(vmOrLabel).kind]
}

export function isCodexVm(vm = {}) {
  return normalizeVmKind(vm).kind === VM_KIND_CODEX
}

export function isGrokVm(vm = {}) {
  return normalizeVmKind(vm).kind === VM_KIND_GROK
}

export function isClaudeVm(vm = {}) {
  return normalizeVmKind(vm).kind === VM_KIND_CLAUDE
}

/** Slots whose container only holds identity/network; inference runs on the host (Codex, Grok). */
export function isHeadlessSlotVm(vm = {}) {
  return !isClaudeVm(vm)
}

export function stampVmKind(vm, input = vm) {
  const kind = normalizeVmKind(input)
  vm.platform = kind.platform
  vm.family = kind.family
  if (kind.kind === VM_KIND_CODEX) {
    vm.codex_kernel = true
    if (!vm.codex || typeof vm.codex !== 'object') vm.codex = {}
    delete vm.claude
    delete vm.grok
  } else if (kind.kind === VM_KIND_GROK) {
    if (!vm.grok || typeof vm.grok !== 'object') vm.grok = {}
    delete vm.claude
    delete vm.codex
    delete vm.codex_kernel
  } else {
    if (!vm.claude || typeof vm.claude !== 'object') vm.claude = {}
    delete vm.codex
    delete vm.codex_kernel
    delete vm.grok
  }
  return kind
}
