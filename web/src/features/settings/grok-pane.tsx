import { KeyRound, ShieldCheck, Waypoints } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { PaneSection } from './scheduler-controls'

type Block = Record<string, unknown>

function asBlock(value: unknown): Block {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Block)
    : {}
}

function textOf(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  disabled?: boolean
  onCommit: (next: number) => void
}) {
  return (
    <Input
      id={id}
      className='w-28'
      type='number'
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : min}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => {
        const next = Math.round(Number(event.target.value))
        if (!Number.isFinite(next)) return
        onCommit(Math.min(max, Math.max(min, next)))
      }}
    />
  )
}

const PROTOCOL_ROWS: { key: string; label: string; modes: string[] }[] = [
  { key: 'openai.responses', label: 'Responses', modes: ['native', 'reject'] },
  { key: 'openai.chat', label: 'Chat Completions', modes: ['native', 'reject'] },
  {
    key: 'anthropic.messages',
    label: 'Claude Messages',
    modes: ['native', 'convert', 'reject'],
  },
]

export function GrokPane({
  grok,
  onChange,
  saving = false,
}: {
  grok: Block
  onChange: (next: Block) => void
  saving?: boolean
}) {
  const oauth = asBlock(grok.oauth)
  const protocols = asBlock(grok.protocols)
  const quota = asBlock(grok.quota)
  const enabled = grok.enabled === true
  const update = (patch: Block) => onChange({ ...grok, ...patch })
  const setProtocol = (key: string, mode: string) => {
    const current = asBlock(protocols[key])
    update({
      protocols: {
        ...protocols,
        [key]: { ...current, mode, enabled: mode !== 'reject' },
      },
    })
  }

  return (
    <div className='space-y-4'>
      <PaneSection
        icon={Waypoints}
        title='Grok 路由'
        desc='关掉之后 grok-* 请求直接拒绝，不会落到 Claude 或 GPT 池。'
        aside={
          <Switch
            checked={enabled}
            disabled={saving}
            onCheckedChange={(next) => update({ enabled: next })}
            aria-label='启用 Grok 路由'
          />
        }
      >
        <div className='divide-y'>
          <SettingRow label='上游地址' desc='默认 https://api.x.ai，必须是 https。'>
            <Input
              className='w-72'
              value={textOf(grok.base_url)}
              disabled={saving}
              onChange={(event) => update({ base_url: event.target.value })}
              aria-label='Grok 上游地址'
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={KeyRound}
        title='xAI OAuth'
        desc='使用 Grok 官方客户端做设备码登录。不用填 client id、授权地址或回调地址。换票地址留空时，会从 auth.x.ai 的发现文档读取。'
      >
        <div className='divide-y'>
          <div className='space-y-1.5'>
            <SettingRow label='提前刷新' desc='access token 到期前多少秒开始换票。'>
              <NumberField
                id='grok-refresh-skew'
                label='Grok 提前刷新秒数'
                min={30}
                max={3600}
                value={Number(oauth.refresh_skew_sec ?? 300)}
                disabled={saving}
                onCommit={(next) =>
                  update({ oauth: { ...oauth, refresh_skew_sec: next } })
                }
              />
            </SettingRow>
          </div>
        </div>
      </PaneSection>

      <PaneSection
        icon={ShieldCheck}
        title='协议与配额'
        desc='默认只放行 Responses 和 Chat。Messages 可以改成原生转发或转成 Responses。'
      >
        <div className='divide-y'>
          {PROTOCOL_ROWS.map((row) => {
            const mode = String(asBlock(protocols[row.key]).mode || 'reject')
            return (
              <SettingRow key={row.key} label={row.label} desc={row.key}>
                <select
                  className='h-8 rounded-md border bg-background px-2 text-sm'
                  value={row.modes.includes(mode) ? mode : 'reject'}
                  disabled={saving}
                  aria-label={`${row.label} 模式`}
                  onChange={(event) => setProtocol(row.key, event.target.value)}
                >
                  {row.modes.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </SettingRow>
            )
          })}
          <SettingRow label='并发' desc='每个 Grok 槽同时进行中的请求数。'>
            <NumberField
              id='grok-concurrency'
              label='Grok 并发'
              min={1}
              max={256}
              value={Number(quota.max_concurrency ?? 2)}
              disabled={saving}
              onCommit={(next) =>
                update({ quota: { ...quota, max_concurrency: next } })
              }
            />
          </SettingRow>
          <SettingRow label='每分钟请求' desc='0 表示不限制。'>
            <NumberField
              id='grok-rpm'
              label='Grok 每分钟请求'
              min={0}
              max={1000000}
              value={Number(quota.max_rpm ?? 0)}
              disabled={saving}
              onCommit={(next) => update({ quota: { ...quota, max_rpm: next } })}
            />
          </SettingRow>
          <SettingRow label='会话数' desc='0 表示不限制。'>
            <NumberField
              id='grok-sessions'
              label='Grok 会话数'
              min={0}
              max={256}
              value={Number(quota.max_sessions ?? 0)}
              disabled={saving}
              onCommit={(next) =>
                update({ quota: { ...quota, max_sessions: next } })
              }
            />
          </SettingRow>
        </div>
      </PaneSection>
    </div>
  )
}
