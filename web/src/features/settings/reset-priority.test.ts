import { describe, expect, it } from 'vitest'
import { fmtIdle, resetIdleOptions, resetPriorityView } from './reset-priority'

describe('resetPriorityView', () => {
  it('defaults on with the provider idle default', () => {
    expect(resetPriorityView({})).toEqual({ enabled: true, idleSec: 300 })
    expect(resetPriorityView({}, 3600)).toEqual({
      enabled: true,
      idleSec: 3600,
    })
  })

  it('reads a saved block and clamps the idle like the backend', () => {
    expect(
      resetPriorityView({ reset_priority: false, reset_priority_idle_sec: 900 })
    ).toEqual({
      enabled: false,
      idleSec: 900,
    })
    expect(resetPriorityView({ reset_priority_idle_sec: 5 }).idleSec).toBe(60)
    expect(
      resetPriorityView({ reset_priority_idle_sec: 10 ** 9 }).idleSec
    ).toBe(86400)
  })
})

describe('idle labels', () => {
  it('formats in Chinese units', () => {
    expect(fmtIdle(300)).toBe('5 分钟')
    expect(fmtIdle(3600)).toBe('1 小时')
  })

  it('keeps a custom saved value selectable', () => {
    expect(resetIdleOptions(300).map(([v]) => v)).toContain(300)
    expect(resetIdleOptions(420).map(([v]) => v)).toContain(420)
  })
})
