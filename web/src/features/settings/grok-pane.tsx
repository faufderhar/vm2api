import { useState, type ComponentProps } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Gauge,
  Info,
  KeyRound,
  Receipt,
  RotateCcw,
  ShieldCheck,
  Users,
  Waypoints,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  fmtInterval,
  GROK_CLIENTS,
  GROK_DEFAULT_BASE_URL,
  GROK_DEFAULT_CLIENT_ID,
  GROK_DEFAULT_SCOPE,
  GROK_LIMITS,
  GROK_MODE_LABEL,
  GROK_PROTOCOLS,
  grokIssues,
  grokView,
  setClient,
  setProtocolMode,
  setSub,
} from './grok-settings-model'
import { settleInt, typingInt } from './int-input'
import { RESET_IDLE_DEFAULT_SEC } from './reset-priority'
import { ResetPrioritySection } from './reset-priority-section'
import { PaneSection } from './scheduler-controls'

type Block = Record<string, unknown>

/** 输入中不夹值（输 5 不会跳成 30），失焦时再按范围收口。 */
function IntField({
  value,
  min,
  max,
  fallback,
  onCommit,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur'> & {
  value: number
  min: number
  max: number
  fallback: number
  onCommit: (next: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      {...props}
      className={cn('w-28 tabular-nums', className)}
      type='number'
      inputMode='numeric'
      min={min}
      max={max}
      value={text ?? String(value)}
      onChange={(event) => {
        setText(event.target.value)
        const n = typingInt(event.target.value)
        if (n !== null && n >= min && n <= max) onCommit(n)
      }}
      onBlur={() => {
        if (text === null) return
        const settled = settleInt(text, min, max, fallback)
        setText(null)
        if (settled !== value) onCommit(settled)
      }}
    />
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} role='alert' className='text-xs text-destructive'>
      {message}
    </p>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <span className='font-mono text-[11px] text-(--text-tertiary)'>
      {children}
    </span>
  )
}

function SettingsLink({
  tab,
  children,
}: {
  tab: 'pool' | 'sticky'
  children: React.ReactNode
}) {
  return (
    <Link
      to='/settings/$tab'
      params={{ tab }}
      className='text-primary underline-offset-2 hover:underline'
    >
      {children}
    </Link>
  )
}

export function GrokPane({
  grok,
  onChange,
  saving = false,
  serverMissing = false,
}: {
  grok: Block
  onChange: (next: Block) => void
  saving?: boolean
  /** 服务端 GET 没回传 grok 段：下面显示的是默认值，不是已保存的配置。 */
  serverMissing?: boolean
}) {
  const view = grokView(grok)
  const issues = grokIssues(grok)
  const issueOf = (field: string) =>
    issues.find((i) => i.field === field)?.message
  const update = (patch: Block) => onChange({ ...grok, ...patch })
  const L = GROK_LIMITS
  const baseUrlError = issueOf('base_url')
  const tokenUrlError = issueOf('token_url')

  return (
    <div className='space-y-4'>
      {serverMissing ? (
        <p
          role='alert'
          className='rounded-lg border border-[color:var(--status-warn)]/50 px-3 py-2 text-xs leading-5 text-[color:var(--status-warn)]'
        >
          服务端没有返回 Grok 配置，下面显示的是默认值，不代表已保存的设置。
          通常是后端还在跑旧版本：升级后请重启 vm2api 服务。
        </p>
      ) : null}
      <PaneSection
        icon={Waypoints}
        title='路由与上游'
        desc='关闭后所有 grok-* 请求直接返回 grok_disabled，不会落到 Claude 或 GPT 池。'
        aside={
          <Switch
            checked={view.enabled}
            disabled={saving}
            onCheckedChange={(next) => update({ enabled: next })}
            aria-label='启用 Grok 路由'
          />
        }
      >
        <div className='divide-y'>
          <SettingRow
            label='上游地址'
            desc={
              <>
                Grok Build 对话上游，对话与 /v1/billing 账单都经 Grok kernel
                发到这里。只能是 https 的 *.grok.com 或 *.x.ai（会携带槽位
                access token）。默认 <Hint>{GROK_DEFAULT_BASE_URL}</Hint>
              </>
            }
          >
            <div className='flex items-center gap-1.5'>
              <Input
                className={cn(
                  'w-72 font-mono text-xs',
                  baseUrlError && 'border-destructive'
                )}
                value={view.baseUrl}
                placeholder={GROK_DEFAULT_BASE_URL}
                disabled={saving}
                aria-invalid={!!baseUrlError}
                aria-describedby={
                  baseUrlError ? 'grok-base-url-err' : undefined
                }
                onChange={(event) => update({ base_url: event.target.value })}
                aria-label='Grok 上游地址'
              />
              <Button
                type='button'
                variant='ghost'
                size='icon'
                className='size-8'
                disabled={saving || view.baseUrl === GROK_DEFAULT_BASE_URL}
                title='恢复默认上游地址'
                aria-label='恢复默认上游地址'
                onClick={() => update({ base_url: GROK_DEFAULT_BASE_URL })}
              >
                <RotateCcw className='size-3.5' aria-hidden />
              </Button>
            </div>
          </SettingRow>
          <FieldError id='grok-base-url-err' message={baseUrlError} />
        </div>
      </PaneSection>

      <PaneSection
        icon={ShieldCheck}
        title='入站协议'
        desc='按入站路径决定 Grok 怎么接：原生转发给上游、转换后再转发，或直接拒绝。'
      >
        <div className='divide-y'>
          {GROK_PROTOCOLS.map((row) => {
            const fixed = row.modes.length === 1
            return (
              <SettingRow
                key={row.key}
                label={row.label}
                desc={
                  <>
                    <Hint>{row.path}</Hint>
                    {row.note ? ` · ${row.note}` : null}
                  </>
                }
              >
                <select
                  className='h-8 w-40 rounded-md border bg-background px-2 text-sm disabled:opacity-60'
                  value={view.protocols[row.key]}
                  disabled={saving || fixed}
                  aria-label={`${row.label} 处理方式`}
                  onChange={(event) =>
                    onChange(
                      setProtocolMode(
                        grok,
                        row.key,
                        event.target.value as (typeof row.modes)[number]
                      )
                    )
                  }
                >
                  {row.modes.map((mode) => (
                    <option key={mode} value={mode}>
                      {GROK_MODE_LABEL[mode]}
                    </option>
                  ))}
                </select>
              </SettingRow>
            )
          })}
          <SettingRow
            label='Responses WebSocket'
            desc='Grok 上游不支持；WS 入口对 grok-* 模型一律拒绝，客户端会回落到 HTTP。'
          >
            <span className='text-xs text-muted-foreground'>不支持</span>
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={Users}
        title='客户端准入'
        desc='按请求头和请求体识别客户端，关闭的类型返回 403 client_not_allowed。'
      >
        <div className='divide-y'>
          {GROK_CLIENTS.map((row) => (
            <SettingRow
              key={row.key}
              label={row.label}
              desc={`${row.desc} 默认${row.fallback === 'allow' ? '放行' : '拒绝'}。`}
            >
              <Switch
                checked={view.clients[row.key] === 'allow'}
                disabled={saving}
                onCheckedChange={(next) =>
                  onChange(setClient(grok, row.key, next))
                }
                aria-label={`放行 ${row.label}`}
              />
            </SettingRow>
          ))}
        </div>
      </PaneSection>

      <PaneSection
        icon={Gauge}
        title='槽位配额默认值'
        desc='保存后下发到所有 Grok 槽；在单台槽位里改过的值（槽位覆写）优先，不会被这里覆盖。'
      >
        <div className='divide-y'>
          <SettingRow
            label='并发上限'
            desc={`每个 Grok 槽同时进行中的请求数，${L.max_concurrency.min}–${L.max_concurrency.max}，默认 ${L.max_concurrency.fallback}。`}
          >
            <IntField
              aria-label='Grok 并发上限'
              {...L.max_concurrency}
              value={view.maxConcurrency}
              disabled={saving}
              onCommit={(next) =>
                onChange(setSub(grok, 'quota', { max_concurrency: next }))
              }
            />
          </SettingRow>
          <SettingRow
            label='每分钟请求（RPM）'
            desc='每个 Grok 槽每分钟最多接的请求数，0 表示不限。'
          >
            <IntField
              aria-label='Grok 每分钟请求'
              {...L.max_rpm}
              value={view.maxRpm}
              disabled={saving}
              onCommit={(next) =>
                onChange(setSub(grok, 'quota', { max_rpm: next }))
              }
            />
          </SettingRow>
          <SettingRow
            label='会话上限'
            desc={`每个 Grok 槽同时粘住的会话数，0 表示不限，最大 ${L.max_sessions.max}。`}
          >
            <IntField
              aria-label='Grok 会话上限'
              {...L.max_sessions}
              value={view.maxSessions}
              disabled={saving}
              onCommit={(next) =>
                onChange(setSub(grok, 'quota', { max_sessions: next }))
              }
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={KeyRound}
        title='xAI OAuth'
        desc='槽位登录走 Grok 官方客户端的设备码流程（auth.x.ai），token 由 Grok kernel 自动续期。下列高级项一般保持留空。'
      >
        <div className='divide-y'>
          <SettingRow
            label='提前续期'
            desc={`access token 到期前多少秒开始换票，${L.refresh_skew_sec.min}–${L.refresh_skew_sec.max} 秒，默认 ${L.refresh_skew_sec.fallback}。`}
          >
            <IntField
              aria-label='Grok 提前续期秒数'
              {...L.refresh_skew_sec}
              value={view.refreshSkewSec}
              disabled={saving}
              onCommit={(next) =>
                onChange(setSub(grok, 'oauth', { refresh_skew_sec: next }))
              }
            />
          </SettingRow>
          <SettingRow
            label='换票地址（token_url）'
            desc='留空则读 auth.x.ai 的 OIDC 发现文档。只能填 https://*.x.ai，或本机回环地址（本地 mock）。'
          >
            <Input
              className={cn(
                'w-72 font-mono text-xs',
                tokenUrlError && 'border-destructive'
              )}
              value={view.tokenUrl}
              placeholder='自动发现'
              disabled={saving}
              aria-invalid={!!tokenUrlError}
              aria-label='Grok 换票地址'
              onChange={(event) =>
                onChange(
                  setSub(grok, 'oauth', { token_url: event.target.value })
                )
              }
            />
          </SettingRow>
          <FieldError id='grok-token-url-err' message={tokenUrlError} />
          <SettingRow label='Client ID' desc='留空使用 Grok CLI 官方客户端。'>
            <Input
              className='w-72 font-mono text-xs'
              value={view.clientId}
              placeholder={GROK_DEFAULT_CLIENT_ID}
              disabled={saving}
              aria-label='Grok OAuth Client ID'
              onChange={(event) =>
                onChange(
                  setSub(grok, 'oauth', { client_id: event.target.value })
                )
              }
            />
          </SettingRow>
          <SettingRow label='Scope' desc='留空使用官方默认 scope。'>
            <Input
              className='w-72 font-mono text-xs'
              value={view.scope}
              placeholder={GROK_DEFAULT_SCOPE}
              disabled={saving}
              aria-label='Grok OAuth Scope'
              onChange={(event) =>
                onChange(setSub(grok, 'oauth', { scope: event.target.value }))
              }
            />
          </SettingRow>
        </div>
      </PaneSection>

      <ResetPrioritySection
        block={grok}
        label='Grok'
        resetLabel='Grok Build 月度账单周期（period_end）'
        defaultIdleSec={RESET_IDLE_DEFAULT_SEC}
        idleReason='与 Grok 槽位会话窗口的空闲判定（5 分钟）一致。重置时间来自用量同步，关闭后台同步后数据会变旧。'
        saving={saving}
        onChange={update}
      />

      <PaneSection
        icon={Receipt}
        title='Grok Build 用量同步'
        desc='后台定时读取每个槽的 Grok Build 账单（周额度与用量），用于虚拟机页的用量窗口。槽位上的「刷新」按钮不受这里限制，随时可强制读取。'
        aside={
          <Switch
            checked={view.billingBackground}
            disabled={saving}
            onCheckedChange={(next) =>
              onChange(setSub(grok, 'billing', { background: next }))
            }
            aria-label='后台同步 Grok Build 用量'
          />
        }
      >
        <div className='divide-y'>
          <SettingRow
            label='最短同步间隔'
            desc={`同一个槽两次后台读取之间至少隔多久，${L.billing_interval_min.min}–${L.billing_interval_min.max} 分钟（当前 ${fmtInterval(view.billingIntervalMin)}）。与 routing.json 的 usage_probe.stale_sec 取较大值。`}
          >
            <IntField
              aria-label='Grok 用量同步间隔（分钟）'
              {...L.billing_interval_min}
              value={view.billingIntervalMin}
              disabled={saving || !view.billingBackground}
              onCommit={(next) =>
                onChange(
                  setSub(grok, 'billing', { min_interval_sec: next * 60 })
                )
              }
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={Info}
        title='在别处设置'
        desc='这些行为 Grok 与 Claude / GPT 共用一套配置。'
      >
        <ul className='space-y-1.5 text-xs leading-5 text-muted-foreground'>
          <li>
            排队等待、流空闲超时、失败重试与换号次数：
            <SettingsLink tab='pool'>账号池</SettingsLink>
          </li>
          <li>
            出站会话 ID（重建 / 透传）：
            <SettingsLink tab='sticky'>粘性</SettingsLink>
          </li>
          <li>
            对外 Grok 模型目录与同步：
            <Link
              to='/models'
              className='text-primary underline-offset-2 hover:underline'
            >
              模型
            </Link>
          </li>
          <li>单台槽位的并发 / RPM / 会话覆写：虚拟机详情页</li>
        </ul>
      </PaneSection>
    </div>
  )
}
