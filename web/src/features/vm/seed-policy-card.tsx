import { useEffect, useState } from 'react'
import type { VmKernelSnapshot, VmSeedSettings } from '@/types/panel-vm'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  REJECT_FLAGS,
  SEED_LOCALE_OPTIONS,
  SEED_TIMEZONE_OPTIONS,
  claudeSettingKeys,
  partitionSeedEnvKeys,
  seedDraftOf,
  seedSaveBody,
  settingsRows,
  sameDraft,
  telemetryLive,
  type SeedDraft,
  type SeedSlotContext,
} from '@/features/vm/seed-settings'
import { telemetryEnabled } from '@/features/vm/telemetry-policy'

type ObservedTelemetry = NonNullable<VmKernelSnapshot['telemetry']>

function Lamp({ tone }: { tone: 'on' | 'off' | 'unknown' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex size-2.5 shrink-0 rounded-full',
        tone === 'on' && 'bg-primary',
        tone === 'off' && 'bg-[var(--status-warn)]',
        tone === 'unknown' && 'bg-muted-foreground/50'
      )}
    >
      {tone !== 'unknown' ? (
        <span
          className={cn(
            'absolute inset-0 rounded-full motion-safe:animate-ping',
            tone === 'on' ? 'bg-primary/70' : 'bg-[var(--status-warn)]/70'
          )}
        />
      ) : null}
    </span>
  )
}

function namedChoice(
  table: readonly (readonly [string, string])[],
  value: string
) {
  return (
    table.find(([key, zone]) => key === value || zone === value)?.[0] ||
    'custom'
  )
}

function ChoiceField({
  label,
  table,
  value,
  disabled,
  onChange,
}: {
  label: string
  table: readonly (readonly [string, string])[]
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const selected = namedChoice(table, value)
  return (
    <Select
      value={selected}
      disabled={disabled}
      onValueChange={(key) =>
        onChange(table.find(([id]) => id === key)?.[1] || value)
      }
    >
      <SelectTrigger className='h-8 font-mono text-xs' aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {table.map(([key, zone]) => (
          <SelectItem key={key} value={key}>{`${key} · ${zone}`}</SelectItem>
        ))}
        {selected === 'custom' ? (
          <SelectItem value='custom'>{value || '自定义'}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}

function LocaleField(props: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return <ChoiceField label='语言' table={SEED_LOCALE_OPTIONS} {...props} />
}

function ZoneField({
  follow,
  fixed,
  proxyZone,
  disabled,
  onFollow,
  onFixed,
}: {
  follow: boolean
  fixed: string
  proxyZone: string
  disabled: boolean
  onFollow: () => void
  onFixed: (value: string) => void
}) {
  return (
    <div className='space-y-1'>
      <ChoiceField
        label='时区'
        table={SEED_TIMEZONE_OPTIONS}
        value={follow ? proxyZone : fixed}
        disabled={disabled}
        onChange={onFixed}
      />
      <Button
        type='button'
        size='sm'
        variant={follow ? 'secondary' : 'ghost'}
        className='h-7 px-2 text-xs'
        disabled={disabled || follow}
        onClick={onFollow}
      >
        {follow
          ? proxyZone
            ? `跟随当前 SOCKS5 · ${proxyZone}`
            : '跟随当前 SOCKS5 · 还没有时区'
          : '改回跟随当前 SOCKS5'}
      </Button>
      <p className='text-[11px] text-muted-foreground'>
        播种时由槽位写入，不经 extra_env
      </p>
    </div>
  )
}

function TelemetryUploadLog({ lines }: { lines: unknown }) {
  const rows = Array.isArray(lines)
    ? lines.filter(
        (line): line is string => typeof line === 'string' && line !== ''
      )
    : []
  return (
    <pre className='mt-2 max-h-72 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] leading-5 text-foreground'>
      {rows.length
        ? rows.join('\n')
        : '还没有上传记录。遥测开着并完成一次上传后会出现。'}
    </pre>
  )
}

function ToggleRow({
  id,
  label,
  detail,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  label: string
  detail: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (next: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between gap-3 py-2.5'>
      <div className='min-w-0'>
        <Label htmlFor={id} className='text-sm font-medium'>
          {label}
        </Label>
        <p className='text-xs text-muted-foreground'>{detail}</p>
      </div>
      <div className='flex items-center gap-2'>
        <span
          className={cn(
            'font-mono text-[11px] tracking-wide',
            checked ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          {checked ? '开' : '关'}
        </span>
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </div>
  )
}

export function SeedPolicyCard({
  seed,
  slot,
  telemetry,
  onSave,
  saving,
  syncTelemetry = false,
  debug,
  onDebug,
  uploadLog,
  proxyTimezone = '',
}: {
  seed: VmSeedSettings
  slot: SeedSlotContext
  telemetry?: ObservedTelemetry | null
  onSave: (next: Record<string, unknown>) => void
  saving: boolean
  syncTelemetry?: boolean
  debug: boolean
  onDebug: (next: boolean) => void
  uploadLog?: string[] | null
  proxyTimezone?: string | null
}) {
  const [locked, setLocked] = useState(true)
  const [askUnlock, setAskUnlock] = useState(false)
  const [askSave, setAskSave] = useState(false)
  const saved = seedDraftOf(seed, slot)
  const [draft, setDraft] = useState<SeedDraft>(saved)
  useEffect(() => {
    setDraft(seedDraftOf(seed, slot))
  }, [seed, slot])

  const dirty = !sameDraft(draft, saved)
  const on = telemetryEnabled(draft)
  const live = telemetryLive(seed, telemetry)
  const fileSetting =
    typeof seed.claude_setting === 'string' ? seed.claude_setting : ''
  const rows = settingsRows(seed.settings_json, fileSetting)
  const claudeNamed = claudeSettingKeys(fileSetting)
  const fileMissing = seed.settings_json == null
  const { editable: editableEnvKeys, readonly: readonlyEnvKeys } =
    partitionSeedEnvKeys(draft.env)
  const editDisabled = locked || saving

  const patch = (next: Partial<SeedDraft>) =>
    setDraft((current) => ({ ...current, ...next }))

  return (
    <div className='grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]'>
      <section className='min-w-0 overflow-hidden rounded-xl border bg-card'>
        <header className='flex items-baseline justify-between gap-3 border-b px-4 py-3'>
          <h2 className='text-sm font-semibold'>当前槽 settings.json</h2>
          <p className='font-mono text-[11px] text-muted-foreground'>
            {fileMissing ? '文件未写入' : `${rows.length} 项`}
            {locked ? ' · 已锁定' : ' · 已解锁'}
          </p>
        </header>
        {fileMissing ? (
          <p className='px-4 py-8 text-sm text-muted-foreground'>
            这槽还没有 settings.json。播种之后，这里显示写进文件的项。
          </p>
        ) : rows.length === 0 ? (
          <p className='px-4 py-8 text-sm text-muted-foreground'>
            文件在，但没有 env 项。
          </p>
        ) : (
          <div className='divide-y'>
            {editableEnvKeys.map((key) => (
              <label
                key={key}
                className='grid items-center gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)]'
              >
                <span className='inline-flex min-w-0 items-center gap-2 font-mono text-xs font-medium break-all'>
                  {claudeNamed.has(key) ? (
                    <span
                      className='size-1.5 shrink-0 rounded-full bg-primary'
                      title='也写在 claude.setting'
                    />
                  ) : (
                    <span className='size-1.5 shrink-0' />
                  )}
                  {key}
                </span>
                <Input
                  aria-label={key}
                  value={draft.env[key] ?? ''}
                  disabled={editDisabled}
                  spellCheck={false}
                  onChange={(event) =>
                    patch({ env: { ...draft.env, [key]: event.target.value } })
                  }
                  className='h-8 font-mono text-xs'
                />
              </label>
            ))}
            <label className='grid items-center gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)]'>
              <span className='font-mono text-xs font-medium'>theme</span>
              <Input
                aria-label='theme'
                value={draft.theme}
                disabled={editDisabled}
                spellCheck={false}
                onChange={(event) => patch({ theme: event.target.value })}
                className='h-8 font-mono text-xs'
              />
            </label>
            {readonlyEnvKeys.map((key) => (
              <div
                key={key}
                className='grid items-center gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)]'
              >
                <span className='inline-flex min-w-0 items-center gap-2 font-mono text-xs font-medium break-all'>
                  {claudeNamed.has(key) ? (
                    <span
                      className='size-1.5 shrink-0 rounded-full bg-primary'
                      title='也写在 claude.setting'
                    />
                  ) : (
                    <span className='size-1.5 shrink-0' />
                  )}
                  {key}
                </span>
                {key === 'TZ' ? (
                  <ZoneField
                    follow={draft.timezoneFollow}
                    fixed={draft.timezoneFixed}
                    proxyZone={proxyTimezone || ''}
                    disabled={editDisabled}
                    onFollow={() =>
                      patch({ timezoneFollow: true, timezoneFixed: '' })
                    }
                    onFixed={(value) =>
                      patch({ timezoneFollow: false, timezoneFixed: value })
                    }
                  />
                ) : key === 'LANG' ? (
                  <LocaleField
                    value={draft.locale}
                    disabled={editDisabled}
                    onChange={(value) => patch({ locale: value })}
                  />
                ) : key === 'LC_ALL' ? (
                  <span className='font-mono text-xs text-muted-foreground'>
                    {draft.locale} · 随 LANG 播种时固定
                  </span>
                ) : (
                  <span className='font-mono text-xs text-muted-foreground'>
                    {draft.env[key] === '' ? '空' : draft.env[key]} · 播种时固定
                  </span>
                )}
              </div>
            ))}
            {rows
              .filter(
                (row) =>
                  row.key === 'autoUpdates' || row.key === 'grove_enabled'
              )
              .map((row) => (
                <div
                  key={row.key}
                  className='grid items-center gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,16rem)]'
                >
                  <span className='font-mono text-xs font-medium'>
                    {row.key}
                  </span>
                  <span className='font-mono text-xs text-muted-foreground'>
                    {row.value} · 播种时固定
                  </span>
                </div>
              ))}
          </div>
        )}
      </section>

      <aside className='min-w-0 rounded-xl border bg-card'>
        <div
          className='flex items-center gap-3 border-b px-4 py-3'
          role='status'
          aria-live='polite'
        >
          <Lamp tone={live.tone} />
          <div className='min-w-0'>
            <p className='text-sm font-semibold'>
              遥测 {live.on === true ? '开' : live.on === false ? '关' : '未知'}
            </p>
            <p className='text-xs text-muted-foreground'>
              {live.label}
              {live.running === true
                ? ' · 进程在跑'
                : live.running === false
                  ? ' · 进程未跑'
                  : ' · 进程未知'}
            </p>
          </div>
        </div>

        <div className='divide-y px-4'>
          <ToggleRow
            id='seed-telemetry'
            label='遥测'
            detail={
              on
                ? '非必要流量=1，DNT 关。这两项跟着开关走。'
                : '非必要流量=0，DNT 开。这两项跟着开关走。'
            }
            checked={on}
            disabled={editDisabled}
            onCheckedChange={(value) => patch({ telemetry_disabled: !value })}
          />
          {REJECT_FLAGS.map(([key, label]) => (
            <ToggleRow
              key={key}
              id={`seed-${key}`}
              label={label}
              detail={
                key === 'reject_client_settings'
                  ? draft.reject_client_settings
                    ? '入站 settings / env 会被丢掉。'
                    : '入站 settings 会留下来。'
                  : draft.reject_client_metadata_identity
                    ? '入站 user / machine 身份会被丢掉。'
                    : '入站身份会留下来。'
              }
              checked={!!draft[key]}
              disabled={editDisabled}
              onCheckedChange={(value) => patch({ [key]: value })}
            />
          ))}
        </div>

        <div className='space-y-2 border-t px-4 py-3'>
          <Label htmlFor='seed-claude-setting' className='text-sm font-medium'>
            claude.setting
          </Label>
          <Textarea
            id='seed-claude-setting'
            value={draft.claude_setting}
            disabled={editDisabled}
            onChange={(event) => patch({ claude_setting: event.target.value })}
            className='min-h-28 font-mono text-xs'
            spellCheck={false}
            placeholder='每行 KEY=value'
          />
          <p className='text-xs text-muted-foreground'>
            {syncTelemetry
              ? '下次换票会按外部初装把遥测重新打开。'
              : '换票不会改这里的遥测开关。'}
            {dirty ? ' 有未播种的改动。' : ' 与当前策略一致。'}
          </p>
        </div>

        <div className='flex gap-2 border-t px-4 py-3'>
          <Button
            size='sm'
            variant='outline'
            disabled={saving || !locked}
            onClick={() => setAskUnlock(true)}
          >
            解锁
          </Button>
          <Button
            size='sm'
            disabled={saving || locked || !dirty}
            onClick={() => setAskSave(true)}
          >
            {saving ? '写入中…' : '播种'}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={saving || locked || !dirty}
            onClick={() => setDraft(saved)}
          >
            重置
          </Button>
        </div>
        <ConfirmDialog
          open={askUnlock}
          onOpenChange={setAskUnlock}
          title='解锁种子配置'
          desc='解锁后才能改当前槽的配置。改完仍要再次确认才会写入。'
          confirmText='解锁'
          cancelBtnText='取消'
          handleConfirm={() => {
            setLocked(false)
            setAskUnlock(false)
          }}
        />
        <ConfirmDialog
          open={askSave}
          onOpenChange={setAskSave}
          title='确认播种'
          desc='把当前改动写入这个槽的 settings.json 和 claude.setting。时区/语言会按槽位规则写入，不会经 extra_env 覆盖契约键。'
          confirmText='确认写入'
          cancelBtnText='取消'
          isLoading={saving}
          handleConfirm={() => {
            onSave(seedSaveBody(draft))
            setAskSave(false)
            setLocked(true)
          }}
        />
        <div className='border-t px-4 py-3'>
          <ToggleRow
            id='seed-telemetry-debug'
            label='调试上传'
            detail={
              debug ? '显示这槽实际上传的遥测。' : '默认关闭，不拉上传记录。'
            }
            checked={debug}
            disabled={saving}
            onCheckedChange={onDebug}
          />
          {debug ? <TelemetryUploadLog lines={uploadLog} /> : null}
        </div>
      </aside>
    </div>
  )
}
