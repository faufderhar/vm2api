import type { Vm, VmDetailPayload } from '@/types/panel-vm'
import { telemetryEnabled } from '@/features/vm/telemetry-policy'

export type LiveKey = 'live' | 'idle' | 'blocked' | 'parked' | 'unknown' | 'off'

export const LIVE_ORDER: LiveKey[] = [
  'live',
  'idle',
  'blocked',
  'parked',
  'unknown',
  'off',
]

export type SlotState = {
  vm: Vm
  on: boolean
  live: LiveKey
  label: string
  probing: boolean
}

/**
 * `on` is the seed bit. The sidecar process stays up even when worker.json has
 * telemetry disabled (no official identity), so a live process alone is not an upload.
 */
export function slotState(
  vm: Vm,
  detail: { data?: VmDetailPayload; isPending: boolean } | undefined
): SlotState {
  const on = telemetryEnabled(vm.seed_policy)
  const observed = detail?.data?.kernel?.telemetry
  const running = observed?.running
  if (!on) {
    return {
      vm,
      on,
      live: 'off',
      label:
        running === true && observed?.enabled === true
          ? '关 · 旁路仍在退出'
          : '关',
      probing: false,
    }
  }
  if (vm.status !== 'running') {
    return { vm, on, live: 'parked', label: '槽已停', probing: false }
  }
  if (!detail || detail.isPending) {
    return { vm, on, live: 'unknown', label: '探测中', probing: true }
  }
  if (observed?.enabled === false) {
    return {
      vm,
      on,
      live: 'blocked',
      label: vm.node_id ? '无官方身份 · 集群槽' : '无官方身份',
      probing: false,
    }
  }
  if (running === true && observed?.enabled === true)
    return { vm, on, live: 'live', label: '上传中', probing: false }
  if (running === false)
    return { vm, on, live: 'idle', label: '进程未运行', probing: false }
  return { vm, on, live: 'unknown', label: '状态未知', probing: false }
}
