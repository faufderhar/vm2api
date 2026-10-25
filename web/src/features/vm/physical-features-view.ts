import type {
  PhysicalFactKey,
  PhysicalFactSource,
  Vm,
  VmPhysicalFeatures,
} from '@/types/panel-vm'
import { isCodexVm, isGrokVm } from '@/lib/vm-kind'

export const NEEDS_BOOT_TEXT = '需开机采集'
export const NOT_COLLECTED_TEXT = '未采集'

const CONTAINER_DOWN_CODES = new Set([
  'slot_container_missing',
  'slot_container_stopped',
])

export function isCollected(features: VmPhysicalFeatures | null | undefined) {
  return !!features?.observed_at
}

/** Badge next to a value that is not a guest observation. */
export function factSourceBadge(
  features: VmPhysicalFeatures | null | undefined,
  key: PhysicalFactKey
): string | null {
  const source: PhysicalFactSource | null | undefined = features?.sources?.[key]
  if (source === 'profile') return '来自档案'
  if (source === 'spec') return '配置值'
  return null
}

/** Empty text for facts only a running guest can report (system, kernel, toolchain…). */
export function guestOnlyEmpty(
  features: VmPhysicalFeatures | null | undefined
) {
  return isCollected(features) ? NOT_COLLECTED_TEXT : NEEDS_BOOT_TEXT
}

export function collectErrorView(
  features: VmPhysicalFeatures | null | undefined
): { code: string | null; message: string; at: string | null } | null {
  const err = features?.collect_error
  const message = err?.message?.trim()
  if (!message) return null
  return { code: err?.code || null, message, at: err?.at || null }
}

/** No running container to read from: offer 「开机并采集」 instead of a plain collect. */
export function containerLikelyDown(vm: Vm) {
  const err = collectErrorView(vm.physical_features)
  if (err?.code && CONTAINER_DOWN_CODES.has(err.code)) return true
  return !!vm.status && vm.status !== 'running'
}

export function canStartAndCollect(vm: Vm) {
  return !isCollected(vm.physical_features) && containerLikelyDown(vm)
}

export function physicalBanner(vm: Vm): string | null {
  const features = vm.physical_features
  if (isCollected(features)) return null
  const fromProfile = Object.values(features?.sources || {}).includes('profile')
  const profileNote = fromProfile
    ? '标「来自档案」的值读自主机上的身份档案（开机后容器里看到的就是这些）；'
    : ''
  const tail = `${profileNote}系统、内核、工具链需开机后采集，开机成功后会自动采集一次。`
  if (isGrokVm(vm)) {
    return `Grok 槽推理走主机 api-kernel，不依赖容器，导入凭证时不会开机，所以还没采集。${tail}`
  }
  if (isCodexVm(vm)) {
    return `GPT 槽推理走主机 Codex 内核，导入凭证时不会开机，所以还没采集。${tail}`
  }
  return `该槽还没采集。${tail}`
}

export const START_AND_COLLECT_CONFIRM =
  '将先开机（启动槽位容器，需要已绑定或可分配的出口代理；未绑定时会从号池分配一个，有凭证的槽会重新参与调度），开机成功后读取容器里的系统、内核和工具链。'

/** runJob key for the start → collect sequence. */
export const START_AND_COLLECT_KEY = '/start+collect-identity'
