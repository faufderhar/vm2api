import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  billingRowSlot,
  isLeftoverUsageAccount,
  isLeftoverUsageRow,
  ledgerRowTitle,
  usageAccountForVm,
  vmCostLedger,
  vmTotalCost,
} from '@/lib/vm-usage'

describe('billingRowSlot', () => {
  const byId = new Map<string, Vm>([
    ['vm-02', { id: 'vm-02', account_uuid: 'new', email: 'new@example.com' }],
    ['vm-05', { id: 'vm-05' }],
  ])

  it('gives a reused slot id only to its bound account', () => {
    expect(
      billingRowSlot({ account_id: 'new', vm_id: 'vm-02' }, byId)?.id
    ).toBe('vm-02')
    expect(
      billingRowSlot({ account_id: 'old', vm_id: 'vm-02' }, byId)
    ).toBeUndefined()
  })

  it('keeps the slot when its bound account is unknown', () => {
    expect(
      billingRowSlot({ account_id: 'any', vm_id: 'vm-05' }, byId)?.id
    ).toBe('vm-05')
  })

  it('has no slot for deleted slots or rows without one', () => {
    expect(
      billingRowSlot({ account_id: 'x', vm_id: 'vm-09' }, byId)
    ).toBeUndefined()
    expect(billingRowSlot({ account_id: 'x' }, byId)).toBeUndefined()
  })
})

describe('GPT vm-id usage rows are live when the slot has no uuid', () => {
  const vm = {
    id: 'vm-codex-01',
    email: 'lemeryvorhees@gmail.com',
    platform: 'openai',
  } as Vm
  const row = {
    account_id: 'vm-codex-01',
    vm_id: 'vm-codex-01',
    total_cost: 139.87,
    today_cost: 24.86,
    window_5h_cost: 0.43,
    window_7d_cost: 139.87,
  }

  it('does not treat a GPT vm-id row as leftover', () => {
    expect(isLeftoverUsageRow(row, vm)).toBe(false)
    expect(isLeftoverUsageAccount(row)).toBe(false)
  })

  it('joins the row so the VM page can show spend', () => {
    expect(usageAccountForVm(vm, [row])?.total_cost).toBe(139.87)
    expect(vmTotalCost(vm, [row])).toBe(139.87)
  })

  it('still drops a reused Claude slot leftover', () => {
    const claude = { id: 'vm-02', account_uuid: 'new-uuid' } as Vm
    const leftover = {
      account_id: 'vm-02',
      vm_id: 'vm-02',
      total_cost: 0,
      today_cost: 0,
    }
    expect(isLeftoverUsageRow(leftover, claude)).toBe(true)
    expect(usageAccountForVm(claude, [leftover])).toBeNull()
  })
})

describe('vmCostLedger', () => {
  const grok = {
    id: 'vm-grok-01',
    platform: 'xai',
    family: 'grok',
    account_uuid: 'g-1',
    window_5h_cost: 99,
    window_7d_cost: 5,
    window_7d_tokens: 700,
    total_cost: 8,
    total_tokens: 1200,
    today_cost: 0.5,
    today_tokens: 40,
    today_requests: 3,
  } as Vm

  it('puts today first for Grok and keeps 7D / total below', () => {
    const rows = vmCostLedger(grok)
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ['today', '今日'],
      ['7d', '7D'],
      ['total', '总计'],
    ])
    expect(rows[0]).toMatchObject({ cost: 0.5, tokens: 40, requests: 3 })
    expect(rows[1].cost).toBe(5)
    expect(rows[2].cost).toBe(8)
  })

  it('prefers the usage account row for today', () => {
    const rows = vmCostLedger(grok, [
      {
        account_id: 'g-1',
        vm_id: 'vm-grok-01',
        today_cost: 1.25,
        today_tokens: 0,
        today_input_tokens: 10,
        today_output_tokens: 5,
        today_requests: 7,
      },
    ])
    expect(rows[0]).toMatchObject({
      key: 'today',
      cost: 1.25,

      requests: 7,
    })
  })

  it('shows zeros instead of hiding today on an idle Grok slot', () => {
    const idle = { id: 'g2', platform: 'xai', family: 'grok' } as Vm
    expect(vmCostLedger(idle)[0]).toMatchObject({
      key: 'today',
      cost: 0,
      tokens: 0,
      requests: 0,
    })
  })

  it('keeps 5H / 7D / total for Claude and GPT', () => {
    const claude = {
      id: 'c',
      window_5h_cost: 1,
      window_7d_cost: 2,
      total_cost: 3,
    } as Vm
    expect(vmCostLedger(claude).map((r) => r.key)).toEqual([
      '5h',
      '7d',
      'total',
    ])
  })

  it('titles the today row with the Shanghai day boundary and leaves 7D bare', () => {
    const [today, week] = vmCostLedger(grok)
    expect(ledgerRowTitle(today)).toContain('上海自然日')
    expect(ledgerRowTitle(today)).toContain('3 次请求')
    expect(ledgerRowTitle(week)).toBeUndefined()
  })

  it('titles the total row with the log coverage start and the retention caveat', () => {
    const since = '2026-10-19T06:00:00.000Z'
    const total = vmCostLedger({ ...grok, log_coverage_start: since })[2]
    expect(total).toMatchObject({ key: 'total', since })
    const title = ledgerRowTitle(total)
    expect(title).toContain(`自 ${new Date(since).toLocaleString()} 起`)
    expect(title).toContain('受日志保留期限制')
  })

  it('says the coverage start is unknown when the slot does not carry it', () => {
    const total = vmCostLedger(grok)[2]
    expect(total.since).toBeNull()
    expect(ledgerRowTitle(total)).toContain('起点未知，受日志保留期限制')
  })
})
