import { createElement } from 'react'
import type { Vm, VmPhysicalFeatures } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VmPhysicalFeaturesCard } from './physical-features-card'
import {
  canStartAndCollect,
  collectErrorView,
  factSourceBadge,
  guestOnlyEmpty,
  physicalBanner,
} from './physical-features-view'

const grok = (features: VmPhysicalFeatures, extra: Partial<Vm> = {}): Vm =>
  ({
    id: 'vm-grok1',
    platform: 'xai',
    family: 'grok',
    status: 'stopped',
    runtime_type: 'docker',
    physical_features: features,
    ...extra,
  }) as unknown as Vm

const PROFILE: VmPhysicalFeatures = {
  observed_at: null,
  runtime_type: 'docker',
  hostname: 'imac15-1-ab12',
  machine_id_present: true,
  cpu_model: 'Intel i7',
  cpu_cores: 16,
  memory_bytes: 2147483648,
  mac: '3c:22:fb:00:11:22',
  dmi: { manufacturer: 'Apple Inc.', product: 'iMac20,1' },
  sources: {
    hostname: 'profile',
    machine_id: 'profile',
    cpu_model: 'profile',
    cpu_cores: 'profile',
    memory_bytes: 'spec',
    mac: 'profile',
    dmi: 'profile',
  },
  collect_error: null,
}

const render = (vm: Vm) =>
  renderToStaticMarkup(
    createElement(VmPhysicalFeaturesCard, {
      vm,
      onCollect: () => {},
      onStartAndCollect: () => {},
    })
  )

describe('physical features display source', () => {
  it('labels profile and spec values, and guest-only facts need a boot', () => {
    expect(factSourceBadge(PROFILE, 'mac')).toBe('来自档案')
    expect(factSourceBadge(PROFILE, 'memory_bytes')).toBe('配置值')
    expect(factSourceBadge({ sources: { mac: 'collected' } }, 'mac')).toBeNull()
    expect(guestOnlyEmpty(PROFILE)).toBe('需开机采集')
    expect(guestOnlyEmpty({ observed_at: '2026-10-25T00:00:00Z' })).toBe(
      '未采集'
    )
  })

  it('Grok banner says inference does not need the container', () => {
    const text = physicalBanner(grok(PROFILE))
    expect(text).toContain('不依赖容器')
    expect(text).toContain('来自档案')
    expect(text).toContain('开机成功后会自动采集一次')
    expect(
      physicalBanner(grok({ ...PROFILE, observed_at: '2026-10-25T00:00:00Z' }))
    ).toBeNull()
  })

  it('renders the 未开机 / 档案值 state', () => {
    const html = render(grok(PROFILE))
    expect(html).toContain('imac15-1-ab12')
    expect(html).toContain('来自档案')
    expect(html).toContain('需开机采集')
    expect(html).toContain('开机并采集')
    expect(html).not.toContain('上次采集失败')
    expect(html).not.toContain('52:54:00')
  })

  it('renders the last collect failure and offers start-and-collect', () => {
    const vm = grok(
      {
        ...PROFILE,
        collect_error: {
          code: 'slot_container_missing',
          message: '该槽没有运行中的容器（kin-grok1 不存在），请先开机再采集',
          at: '2026-10-25T08:00:00.000Z',
        },
      },
      { status: 'running' }
    )
    expect(collectErrorView(vm.physical_features)?.code).toBe(
      'slot_container_missing'
    )
    expect(canStartAndCollect(vm)).toBe(true)
    const html = render(vm)
    expect(html).toContain('上次采集失败')
    expect(html).toContain('该槽没有运行中的容器')
    expect(html).toContain('开机并采集')
    expect(html).not.toContain('Error response from daemon')
  })

  it('renders the collected state without badges or the boot button', () => {
    const vm = grok(
      {
        ...PROFILE,
        observed_at: '2026-10-25T08:00:00.000Z',
        os_pretty: 'Ubuntu 24.04.1 LTS',
        os_id: 'ubuntu',
        kernel_release: '6.8.0-51-generic',
        arch: 'x64',
        shell: 'bash',
        sources: {
          hostname: 'collected',
          cpu_model: 'collected',
          mac: 'collected',
          dmi: 'collected',
          machine_id: 'collected',
        },
      },
      { status: 'running' }
    )
    expect(canStartAndCollect(vm)).toBe(false)
    const html = render(vm)
    expect(html).toContain('Ubuntu 24.04.1 LTS (ubuntu)')
    expect(html).not.toContain('来自档案')
    expect(html).not.toContain('需开机采集')
    expect(html).not.toContain('开机并采集')
  })
})
