import type { BillingItem } from '@/types/panel-billing'
import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { splitBilling } from './split'

function row(vm_id: string, cost: number): BillingItem {
  return {
    vm_id,
    requests: 1,
    ok: 1,
    fail: 0,
    tokens_in: 10,
    tokens_out: 5,
    cost_usd: cost,
  }
}

const vms = new Map<string, Vm>([
  ['vm-c', { id: 'vm-c', platform: 'anthropic' } as Vm],
  ['vm-g', { id: 'vm-g', platform: 'openai' } as Vm],
  ['vm-x', { id: 'vm-x', platform: 'xai', family: 'grok' } as Vm],
])

describe('billing platform split', () => {
  it('puts GPT slots under GPT and Claude slots under Claude', () => {
    const out = splitBilling([row('vm-c', 2), row('vm-g', 3)], 'vm', vms)
    expect(out.claude.cost_usd).toBe(2)
    expect(out.gpt.cost_usd).toBe(3)
    const withGrok = splitBilling(
      [row('vm-c', 2), row('vm-g', 3), row('vm-x', 4)],
      'vm',
      vms
    )
    expect(withGrok.grok.cost_usd).toBe(4)
    expect(withGrok.claude.cost_usd).toBe(2)
  })

  it('does not count unknown slots as Claude', () => {
    const out = splitBilling([row('vm-gone', 7)], 'vm', new Map())
    expect(out.rows[0].kind).toBeNull()
    expect(out.claude.cost_usd).toBe(0)
    expect(out.gpt.cost_usd).toBe(0)
    expect(out.grok.cost_usd).toBe(0)
  })

  it('does not split when grouped by key', () => {
    const out = splitBilling([row('vm-g', 3)], 'key', vms)
    expect(out.rows[0].kind).toBeNull()
  })
})
