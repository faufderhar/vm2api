import type { Vm, VmDetailPayload } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { slotState } from './telemetry-slot-state'

const vm = (patch: Partial<Vm> = {}): Vm => ({
  id: 'vm-1',
  status: 'running',
  seed_policy: { telemetry_disabled: false },
  ...patch,
})

const detail = (
  telemetry: { enabled?: boolean | null; running?: boolean | null } | null
) => ({
  isPending: false,
  data: { kernel: { telemetry } } as VmDetailPayload,
})

describe('telemetry slot state', () => {
  it('does not call a live sidecar with no official identity an upload', () => {
    const local = slotState(vm(), detail({ enabled: false, running: true }))
    expect(local).toMatchObject({ live: 'blocked', label: '无官方身份' })
    const remote = slotState(
      vm({ node_id: 'node-1' }),
      detail({ enabled: false, running: true })
    )
    expect(remote).toMatchObject({
      live: 'blocked',
      label: '无官方身份 · 集群槽',
    })
  })

  it('uploads only when worker.json is on and the sidecar runs', () => {
    expect(slotState(vm(), detail({ enabled: true, running: true })).live).toBe(
      'live'
    )
    expect(
      slotState(vm(), detail({ enabled: true, running: false })).live
    ).toBe('idle')
    expect(slotState(vm(), detail({ enabled: null, running: true })).live).toBe(
      'unknown'
    )
  })

  it('keeps unknown observations unknown, not off', () => {
    expect(slotState(vm(), detail(null))).toMatchObject({
      live: 'unknown',
      label: '状态未知',
    })
    expect(slotState(vm(), undefined)).toMatchObject({
      live: 'unknown',
      probing: true,
    })
  })

  it('follows the seed bit before any observation', () => {
    expect(
      slotState(
        vm({ seed_policy: { telemetry_disabled: true } }),
        detail({ enabled: false, running: true })
      )
    ).toMatchObject({
      on: false,
      live: 'off',
      label: '关',
    })
    expect(slotState(vm({ status: 'stopped' }), undefined).live).toBe('parked')
  })
})
