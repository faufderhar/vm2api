import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { opsModelFamilyRows } from '@/features/overview/traffic-ops'

const grok: Vm = { id: 'heavy', platform: 'xai', family: 'grok' }

describe('opsModelFamilyRows', () => {
  it('shows only Grok when the fleet and the hour are Grok', () => {
    const rows = opsModelFamilyRows(
      [{ model: 'grok-4.7', requests: 3, errors: 1 }],
      [grok]
    )
    expect(rows.map((row) => row.model)).toEqual(['Grok Build'])
    expect(rows[0]?.requests).toBe(3)
    expect(rows[0]?.errors).toBe(1)
  })

  it('still shows the Claude matrix when no slots are passed', () => {
    const rows = opsModelFamilyRows([{ model: 'grok-4.6', requests: 2 }])
    expect(rows.map((row) => row.model)).toEqual([
      'Opus',
      'Sonnet',
      'Haiku',
      'Fable',
      'Grok Build',
    ])
  })
})
