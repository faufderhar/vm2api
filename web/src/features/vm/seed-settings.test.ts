import { describe, expect, it } from 'vitest'
import { vmSeedQueryOptions, vmSeedUploadLogQueryOptions } from './queries'
import {
  claudeSettingKeys,
  editableSeedEnv,
  isReadonlySeedEnvKey,
  partitionSeedEnvKeys,
  seedDraftOf,
  seedSaveBody,
  settingsRows,
  telemetryLive,
} from './seed-settings'

const settings = {
  env: {
    TZ: 'Asia/Shanghai',
    LANG: 'en_US.UTF-8',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
    CLAUDE_CODE_USE_BEDROCK: '0',
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    CUSTOM_FLAG: 'kept',
  },
  theme: 'dark',
  autoUpdates: false,
}

describe('current slot settings', () => {
  it('lists the file env, marking lines also named in claude.setting', () => {
    const rows = settingsRows(
      settings,
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n# note\n'
    )
    expect(
      rows.map((row) => [row.key, row.value, row.inClaudeSetting])
    ).toEqual([
      ['TZ', 'Asia/Shanghai', false],
      ['LANG', 'en_US.UTF-8', false],
      ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '0', true],
      ['CLAUDE_CODE_USE_BEDROCK', '0', false],
      ['DISABLE_TELEMETRY', '1', false],
      ['DO_NOT_TRACK', '1', false],
      ['CUSTOM_FLAG', 'kept', false],
      ['CLAUDE_CODE_ATTRIBUTION_HEADER', '0', false],
      ['theme', 'dark', false],
      ['autoUpdates', 'false', false],
    ])
  })

  it('does not invent rows when the file is missing', () => {
    expect(settingsRows(null, 'TZ=UTC')).toEqual([])
    expect(claudeSettingKeys('# only\n\nNOT A KEY\nOK=1')).toEqual(
      new Set(['OK'])
    )
  })
})

describe('seed draft', () => {
  it('shows reject flags from the current policy, not a preset', () => {
    const draft = seedDraftOf({
      seed_policy: {
        telemetry_disabled: false,
        reject_client_settings: false,
        reject_client_metadata_identity: true,
      },
      claude_setting: 'A=1\r\nB=2\r\n',
    })
    expect(draft.reject_client_settings).toBe(false)
    expect(draft.reject_client_metadata_identity).toBe(true)
    expect(draft.telemetry_disabled).toBe(false)
    expect(draft.claude_setting).toBe('A=1\nB=2\n')
    expect(seedSaveBody(draft)).toMatchObject({
      telemetry_disabled: false,
      disable_nonessential_traffic: true,
      do_not_track: false,
      reject_client_settings: false,
      reject_client_metadata_identity: true,
      claude_setting: 'A=1\nB=2',
    })
  })

  it('keeps an explicit false identity flag instead of defaulting it on', () => {
    const draft = seedDraftOf({
      seed_policy: { reject_client_metadata_identity: false },
    })
    expect(draft.reject_client_metadata_identity).toBe(false)
    expect(draft.reject_client_settings).toBe(true)
  })

  it('keeps a missing or empty claude.setting empty', () => {
    expect(
      seedDraftOf({
        seed_policy: { claude_setting: 'FROM_POLICY=1' },
        claude_setting: '',
      }).claude_setting
    ).toBe('')
    expect(
      seedDraftOf({ seed_policy: { claude_setting: 'FROM_POLICY=1' } })
        .claude_setting
    ).toBe('')
  })

  it('saves edited settings env, including the attribution default', () => {
    const draft = seedDraftOf({
      settings_json: { env: { CUSTOM: 'before' } },
      claude_setting: '',
    })
    expect(draft.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
    draft.env.CUSTOM = 'after'
    expect(seedSaveBody(draft).extra_env).toMatchObject({
      CUSTOM: 'after',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    })
  })

  it('sends slot timezone follow or fixed locale without extra_env TZ/LANG', () => {
    const follow = seedDraftOf(
      { settings_json: { env: { TZ: 'UTC' } }, claude_setting: '' },
      { timezone_source: 'auto', timezone: 'Asia/Tokyo', locale: 'ja_JP.UTF-8' }
    )
    expect(follow.timezoneFollow).toBe(true)
    expect(seedSaveBody(follow)).toMatchObject({
      timezone_follow_proxy: true,
      locale: 'ja_JP.UTF-8',
      extra_env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
    })
    expect(seedSaveBody(follow).extra_env).not.toHaveProperty('TZ')

    const fixed = seedDraftOf(
      { settings_json: { env: { TZ: 'UTC' } }, claude_setting: '' },
      {
        timezone_source: 'manual',
        timezone: 'Europe/Berlin',
        locale: 'en_US.UTF-8',
      }
    )
    fixed.timezoneFixed = 'America/New_York'
    fixed.timezoneFollow = false
    expect(seedSaveBody(fixed)).toMatchObject({
      timezone: 'America/New_York',
      locale: 'en_US.UTF-8',
    })
    expect(seedSaveBody(fixed).timezone_follow_proxy).toBeUndefined()
  })

  it('omits contract-locked env keys from extra_env on save', () => {
    const draft = seedDraftOf({
      settings_json: {
        env: {
          TZ: 'Asia/Shanghai',
          CUSTOM_FLAG: 'kept',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
          CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
        },
      },
      claude_setting: '',
    })
    draft.env.CUSTOM_FLAG = 'edited'
    draft.env.TZ = 'UTC'
    expect(editableSeedEnv(draft.env)).toEqual({
      CUSTOM_FLAG: 'edited',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    })
    expect(seedSaveBody(draft).extra_env).toEqual({
      CUSTOM_FLAG: 'edited',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    })
  })

  it('keeps theme editable and leaves fixed settings visible', () => {
    const draft = seedDraftOf({
      settings_json: {
        env: {},
        theme: 'light',
        autoUpdates: false,
        grove_enabled: false,
      },
      claude_setting: '',
    })
    expect(draft.theme).toBe('light')
    expect(
      settingsRows(
        draft.env && {
          env: draft.env,
          theme: 'light',
          autoUpdates: false,
          grove_enabled: false,
        },
        ''
      ).map((row) => row.key)
    ).toContain('autoUpdates')
    expect(seedSaveBody({ ...draft, theme: 'dark' }).theme).toBe('dark')
  })
})

describe('readonly seed env keys', () => {
  it('locks TZ, kill-switch, cloud off, and gateway hint keys', () => {
    for (const key of [
      'TZ',
      'LANG',
      'LC_ALL',
      'DISABLE_TELEMETRY',
      'DO_NOT_TRACK',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_GATEWAY_HINT_HEADERS',
      'MY_GATEWAY_HINT_FLAG',
    ]) {
      expect(isReadonlySeedEnvKey(key)).toBe(true)
    }
    expect(isReadonlySeedEnvKey('CUSTOM_FLAG')).toBe(false)
    expect(isReadonlySeedEnvKey('CLAUDE_CODE_ATTRIBUTION_HEADER')).toBe(false)
  })

  it('partitions env keys for the form', () => {
    expect(
      partitionSeedEnvKeys({
        TZ: 'UTC',
        CUSTOM: '1',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      })
    ).toEqual({
      editable: ['CLAUDE_CODE_ATTRIBUTION_HEADER', 'CUSTOM'],
      readonly: ['TZ'],
    })
  })
})

describe('seed queries', () => {
  it('keeps seed-settings query key stable when debug upload toggles', () => {
    expect(vmSeedQueryOptions('vm-1').queryKey).toEqual([
      'panel',
      'vm',
      'vm-1',
      'seed',
    ])
    expect(vmSeedUploadLogQueryOptions('vm-1').queryKey).toEqual([
      'panel',
      'vm',
      'vm-1',
      'seed-upload-log',
    ])
    expect(vmSeedQueryOptions('vm-1').queryKey).not.toContain(true)
    expect(vmSeedQueryOptions('vm-1').queryKey).not.toContain(false)
  })
})

describe('telemetry lamp', () => {
  it('stays off while a process is still running', () => {
    const live = telemetryLive(
      { seed_policy: { telemetry_disabled: true } },
      { enabled: true, running: true }
    )
    expect(live).toMatchObject({ on: false, running: true, tone: 'off' })
    expect(live.label).toBe('未启用')
  })

  it('stays on when the process has not started', () => {
    const live = telemetryLive(
      { seed_policy: { telemetry_disabled: false } },
      { enabled: false, running: false }
    )
    expect(live).toMatchObject({
      on: true,
      running: false,
      tone: 'on',
      label: '已开启 · 进程未运行',
    })
  })

  it('does not call a missing observation off', () => {
    expect(telemetryLive({}, null)).toMatchObject({
      on: null,
      running: null,
      tone: 'unknown',
    })
  })
})
