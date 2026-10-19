import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { opsModelFamilyRows } from '@/features/overview/traffic-ops'

const grok: Vm = { id: 'heavy', platform: 'xai', family: 'grok' }

describe('opsModelFamilyRows', () => {
  it('splits Grok traffic by model instead of one Grok row', () => {
    const rows = opsModelFamilyRows(
      [
        { model: 'grok-4.7', requests: 3, errors: 1 },
        { model: 'grok-4.6', requests: 1, errors: 0 },
        {
          model: 'grok-4.7',
          requests: 1,
          errors: 0,
          avg_first_token_ms: 100,
          ttft_samples: 1,
        },
      ],
      [grok]
    )
    expect(rows.map((row) => row.model)).toEqual(['grok-4.7', 'grok-4.6'])
    expect(rows[0]).toMatchObject({ requests: 4, errors: 1 })
    expect(rows[1]).toMatchObject({ requests: 1, errors: 0 })
  })

  it('still shows the Claude matrix when no slots are passed', () => {
    const rows = opsModelFamilyRows([{ model: 'grok-4.6', requests: 2 }])
    expect(rows.map((row) => row.model)).toEqual([
      'Opus',
      'Sonnet',
      'Haiku',
      'Fable',
      'grok-4.6',
    ])
  })
})
