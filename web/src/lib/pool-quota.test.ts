import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { poolQuota } from '@/lib/pool-quota'

const claude: Vm = {
  id: 'vm-01',
  has_token: true,
  platform: 'anthropic',
  family: 'claude',
  usage_has_fable: false,
  utilization_5h: 0.4,
}

const grok: Vm = {
  id: 'heavy',
  has_token: true,
  platform: 'xai',
  family: 'grok',
  utilization_5h: 0.9,
  grok: { limited_until: 2_000 },
}

describe('poolQuota', () => {
  it('keeps a Grok slot out of the Claude 5h window', () => {
    const quota = poolQuota([claude, grok], 1_000)
    const fiveHour = quota.windows[0]
    expect(fiveHour.segs.map((seg) => seg.id)).toEqual(['vm-01'])
    expect(quota.eligible).toBe(1)
    expect(quota.withToken).toBe(1)
    expect(quota.grok).toEqual({
      withToken: 1,
      eligible: 1,
      limited: 1,
      synced: 0,
    })
    expect(quota.grokWindow?.label).toBe('Grok')
    expect(quota.grokWindow?.segs[0]).toMatchObject({
      id: 'heavy',
      probed: false,
    })
  })

  it('does not count an expired Grok park as limited', () => {
    const quiet: Vm = {
      ...grok,
      grok: { limited_until: 500 },
    }
    expect(poolQuota([quiet], 1_000).grok.limited).toBe(0)
  })

  it('draws the Grok Build weekly percent instead of a Claude window', () => {
    const synced: Vm = {
      ...grok,
      grok_build: {
        credit_usage_percent: 42,
        period_end: '2099-01-01T00:00:00.000Z',
        ok: true,
      },
    }
    const quota = poolQuota([synced], 1_000)
    expect(quota.windows[0].segs).toEqual([])
    expect(quota.grok.synced).toBe(1)
    expect(quota.grokWindow?.segs[0]).toMatchObject({
      id: 'heavy',
      usedPct: 42,
      probed: true,
    })
  })
})
