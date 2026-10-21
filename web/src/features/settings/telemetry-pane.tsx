import { useState } from 'react'
import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { ArrowRight, ChevronRight, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import {
  ChipGroup,
  StepperSetting,
} from '@/features/settings/scheduler-controls'
import {
  amountIn,
  intervalLabel,
  secondsFrom,
  unitBounds,
  unitOf,
  UPLOAD_INTERVAL_PRESETS,
  type IntervalUnit,
} from '@/features/settings/telemetry-interval'
import {
  LIVE_ORDER,
  slotState,
  type LiveKey,
  type SlotState,
} from '@/features/settings/telemetry-slot-state'
import {
  relativeAgo,
  summarizeUploads,
  type UploadEntry,
} from '@/features/settings/telemetry-upload-log'
import {
  vmQueryOptions,
  vmSeedUploadLogQueryOptions,
} from '@/features/vm/queries'
import {
  telemetryEnabled,
  telemetrySeedFlags,
} from '@/features/vm/telemetry-policy'

const LIVE: Record<LiveKey, { legend: string; swatch: string; text: string }> =
  {
    live: {
      legend: '上传中',
      swatch: 'bg-primary',
      text: 'text-primary',
    },
    idle: {
      legend: '开 · 进程未跑',
      swatch: 'bg-[var(--status-caution-solid)]',
      text: 'text-[var(--status-caution)]',
    },
    blocked: {
      legend: '开 · 无官方身份',
      swatch: 'bg-[var(--status-warn-solid)]',
      text: 'text-[var(--status-warn)]',
    },
    parked: {
      legend: '开 · 槽已停',
      swatch: 'bg-[var(--ok-2)]',
      text: 'text-muted-foreground',
    },
    unknown: {
      legend: '开 · 状态未知',
      swatch: 'bg-[var(--status-none)]',
      text: 'text-muted-foreground',
    },
    off: {
      legend: '关',
      swatch: 'bg-[var(--track)]',
      text: 'text-muted-foreground',
    },
  }

type SeedPutResult = {
  service?: {
    failed_count?: number
    items?: { error?: string }[]
  } | null
}

/** Returns the sidecar restart error, if the seed write itself succeeded but the restart did not. */
async function writeTelemetry(id: string, enabled: boolean) {
  const res = await api<SeedPutResult>(
    `/api/panel/vms/${encodeURIComponent(id)}/seed-settings`,
    { method: 'PUT', body: JSON.stringify(telemetrySeedFlags(enabled)) }
  )
  const svc = res?.service
  if (!svc?.failed_count) return null
  return svc.items?.find((item) => item.error)?.error || '遥测旁路重启失败'
}

async function refreshAfterWrite(qc: QueryClient, ids: string[]) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
    ...ids.map((id) => qc.invalidateQueries({ queryKey: ['panel', 'vm', id] })),
  ])
}

const CONTRACT: { file: string; key: string; on: string; off: string }[] = [
  {
    file: 'settings.json · env',
    key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    on: '"1"',
    off: '"0"',
  },
  {
    file: 'settings.json · env',
    key: 'DISABLE_TELEMETRY',
    on: '不写',
    off: '"1"',
  },
  {
    file: 'settings.json · env',
    key: 'DO_NOT_TRACK',
    on: '不写',
    off: '"1"',
  },
  {
    file: 'settings.json · env',
    key: 'CLAUDE_CODE_USE_BEDROCK / VERTEX',
    on: '"0"',
    off: '"0"',
  },
  {
    file: 'settings.json',
    key: 'grove_enabled',
    on: 'false',
    off: 'false',
  },
  {
    file: 'kin-seed.json',
    key: 'telemetry',
    on: 'enabled',
    off: 'disabled',
  },
  {
    file: 'run/worker.json',
    key: 'telemetry.enabled',
    on: 'true',
    off: 'false',
  },
]

function pipeline(interval: number): { title: string; body: string }[] {
  return [
    {
      title: '播种',
      body: '开关写进上表各文件。运行中的槽切换后会重启遥测旁路；本机槽同时重启 kin-egress。',
    },
    {
      title: '身份',
      body: '旁路只用官方初装留下的身份。还没有身份时 worker.json 保持关闭，旁路空转、不上传。',
    },
    {
      title: '上传',
      body: `有会话活动时每 ${intervalLabel(interval)} 发一批 event_logging/v2/batch；GrowthBook eval 启动即发，之后每 6 小时。`,
    },
    {
      title: '静默',
      body: '最后一次活动后 10 分钟停发。CLI 自己发出的遥测请求由网关本地应答，不出网。',
    },
  ]
}

function IntervalSetting({
  value,
  onChange,
}: {
  value: number
  onChange: (seconds: number) => void
}) {
  const [unit, setUnit] = useState<IntervalUnit>(() => unitOf(value))
  const [min, max] = unitBounds(unit)
  const switchUnit = (next: IntervalUnit) => {
    setUnit(next)
    const seconds = secondsFrom(amountIn(value, next), next)
    if (seconds !== value) onChange(seconds)
  }
  return (
    <div className='space-y-3 border-t border-[var(--hairline)] pt-4'>
      <StepperSetting
        id='telemetry-upload-interval'
        label='上传间隔'
        desc={
          <>
            有会话活动时，每隔这么久发一批事件。全局生效，保存后热更新各槽的
            worker.json，不重启旁路。
            {value > 600
              ? '超过 10 分钟时，只有间隔到点且 10 分钟内有活动才会发。'
              : ''}
          </>
        }
        value={amountIn(value, unit)}
        min={min}
        max={max}
        unit={unit === 'hour' ? '小时' : '分钟'}
        onChange={(amount) => onChange(secondsFrom(amount, unit))}
      />
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
        <ChipGroup
          label='常用间隔'
          value={value}
          options={UPLOAD_INTERVAL_PRESETS}
          onChange={(seconds) => {
            setUnit(unitOf(seconds))
            onChange(seconds)
          }}
        />
        <ChipGroup<IntervalUnit>
          label='单位'
          value={unit}
          options={[
            ['min', '分钟'],
            ['hour', '小时'],
          ]}
          onChange={switchUnit}
        />
      </div>
    </div>
  )
}

export function TelemetryPane({
  interval,
  onIntervalChange,
}: {
  interval: number
  onIntervalChange: (seconds: number) => void
}) {
  const qc = useQueryClient()
  const dash = useQuery(dashboardQueryOptions())
  const routing = useQuery(routingQueryOptions())
  const vms: Vm[] = dash.data?.vms || []
  const claude = vms.filter((vm) => !isCodexVm(vm))
  const codexCount = vms.length - claude.length
  const probed = claude.filter(
    (vm) => vm.status === 'running' && telemetryEnabled(vm.seed_policy)
  )
  const details = useQueries({
    queries: probed.map((vm) => ({
      ...vmQueryOptions(vm.id),
      refetchInterval: 20_000,
      refetchOnWindowFocus: false,
    })),
  })
  const detailById = new Map(probed.map((vm, i) => [vm.id, details[i]]))
  const slots = claude.map((vm) => slotState(vm, detailById.get(vm.id)))

  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [bulk, setBulk] = useState<{
    enabled: boolean
    done: number
    total: number
    current: string
  } | null>(null)
  const [confirm, setConfirm] = useState<boolean | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const setOne = async (vm: Vm, enabled: boolean) => {
    setBusy((cur) => new Set(cur).add(vm.id))
    try {
      const svcError = await writeTelemetry(vm.id, enabled)
      if (svcError) {
        toast.warning(
          `${vm.id} 已${enabled ? '开启' : '关闭'}，旁路重启失败：${svcError}`
        )
      } else {
        toast.success(`${vm.id} 遥测已${enabled ? '开启' : '关闭'}`)
      }
    } catch (error) {
      toast.error(
        `${vm.id} 写入失败：${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      await refreshAfterWrite(qc, [vm.id])
      setBusy((cur) => {
        const next = new Set(cur)
        next.delete(vm.id)
        return next
      })
    }
  }

  const runBulk = async (enabled: boolean) => {
    const targets = claude.filter(
      (vm) => telemetryEnabled(vm.seed_policy) !== enabled
    )
    setConfirm(null)
    if (!targets.length) return
    const failed: string[] = []
    const restartFailed: string[] = []
    for (const [index, vm] of targets.entries()) {
      setBulk({ enabled, done: index, total: targets.length, current: vm.id })
      try {
        if (await writeTelemetry(vm.id, enabled)) restartFailed.push(vm.id)
      } catch {
        failed.push(vm.id)
      }
    }
    setBulk(null)
    await refreshAfterWrite(
      qc,
      targets.map((vm) => vm.id)
    )
    const ok = targets.length - failed.length
    const verb = enabled ? '开启' : '关闭'
    if (failed.length) {
      toast.error(
        `已${verb} ${ok} 槽，失败 ${failed.length}：${failed.join('、')}`
      )
    } else if (restartFailed.length) {
      toast.warning(
        `已${verb} ${ok} 槽；旁路重启失败：${restartFailed.join('、')}`
      )
    } else {
      toast.success(`已${verb} ${ok} 槽`)
    }
  }

  const counts = LIVE_ORDER.map(
    (key) => [key, slots.filter((s) => s.live === key).length] as const
  )
  const onCount = slots.filter((s) => s.on).length
  const toEnable = claude.length - onCount
  const pendingTargets =
    confirm === null
      ? []
      : claude.filter((vm) => telemetryEnabled(vm.seed_policy) !== confirm)
  const pendingRunning = pendingTargets.filter(
    (vm) => vm.status === 'running'
  ).length
  const pendingRemote = pendingTargets.filter((vm) => vm.node_id).length
  const fetching = dash.isFetching || details.some((d) => d.isFetching)
  const steps = pipeline(interval)
  const official = routing.data?.official_cc as
    { sync_telemetry?: boolean } | undefined
  const codex = routing.data?.codex as
    { analytics?: { enabled?: boolean } } | undefined

  return (
    <div className='space-y-3'>
      <Card className='gap-5'>
        <CardHeader className='flex flex-wrap items-start justify-between gap-x-6 gap-y-3'>
          <div className='min-w-0 space-y-1.5'>
            <CardTitle className='text-base'>遥测</CardTitle>
            <p className='max-w-[60ch] text-sm text-muted-foreground'>
              每个 Claude 槽只有一个开关，存在种子策略{' '}
              <code className='font-mono text-xs text-foreground'>
                telemetry_disabled
              </code>
              。其余键都跟着它写。
              {codexCount
                ? ` GPT 槽没有遥测旁路，${codexCount} 个不在此列。`
                : ''}
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <Button
              size='sm'
              disabled={!!bulk || toEnable === 0}
              onClick={() => setConfirm(true)}
            >
              全部开启
              {toEnable ? (
                <span className='font-mono text-xs tabular-nums opacity-80'>
                  {toEnable}
                </span>
              ) : null}
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!!bulk || onCount === 0}
              onClick={() => setConfirm(false)}
            >
              全部关闭
              {onCount ? (
                <span className='font-mono text-xs tabular-nums opacity-80'>
                  {onCount}
                </span>
              ) : null}
            </Button>
            <Button
              size='icon'
              variant='ghost'
              className='size-8'
              aria-label='重新探测'
              disabled={fetching}
              onClick={() => {
                void dash.refetch()
                for (const d of details) void d.refetch()
              }}
            >
              <RefreshCw
                className={cn('size-4', fetching && 'motion-safe:animate-spin')}
              />
            </Button>
          </div>
        </CardHeader>
        <CardContent className='space-y-3'>
          <FleetBar counts={counts} total={slots.length} />
          <div className='flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs'>
            {counts.map(([key, n]) =>
              n ? (
                <span key={key} className='inline-flex items-center gap-1.5'>
                  <span
                    aria-hidden
                    className={cn('size-2 rounded-[2px]', LIVE[key].swatch)}
                  />
                  <span className='text-muted-foreground'>
                    {LIVE[key].legend}
                  </span>
                  <span className='font-mono text-foreground tabular-nums'>
                    {n}
                  </span>
                </span>
              ) : null
            )}
            <span className='ms-auto font-mono text-muted-foreground tabular-nums'>
              {onCount} / {slots.length} 开
            </span>
          </div>
          {bulk ? (
            <div
              role='status'
              className='flex items-center gap-3 rounded-md bg-muted/60 px-3 py-2 text-xs'
            >
              <span className='text-muted-foreground'>
                正在{bulk.enabled ? '开启' : '关闭'}
              </span>
              <span className='font-mono text-foreground'>{bulk.current}</span>
              <span className='relative h-1 flex-1 overflow-hidden rounded-full bg-[var(--track)]'>
                <span
                  className='absolute inset-y-0 left-0 rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-300'
                  style={{ width: `${(bulk.done / bulk.total) * 100}%` }}
                />
              </span>
              <span className='font-mono text-muted-foreground tabular-nums'>
                {bulk.done}/{bulk.total}
              </span>
            </div>
          ) : null}
          <IntervalSetting value={interval} onChange={onIntervalChange} />
        </CardContent>
      </Card>

      <Card className='gap-0 py-0'>
        {dash.isLoading ? (
          <p className='px-6 py-5 text-sm text-muted-foreground'>读取槽位…</p>
        ) : slots.length === 0 ? (
          <p className='px-6 py-5 text-sm text-muted-foreground'>
            还没有 Claude 槽。建好槽并完成官方初装后，这里会列出它的遥测状态。
          </p>
        ) : (
          <ul className='divide-y divide-[var(--hairline)]'>
            {slots.map((slot) => (
              <SlotRow
                key={slot.vm.id}
                slot={slot}
                busy={busy.has(slot.vm.id) || bulk?.current === slot.vm.id}
                locked={!!bulk}
                open={open === slot.vm.id}
                onToggleOpen={() =>
                  setOpen((cur) => (cur === slot.vm.id ? null : slot.vm.id))
                }
                onSet={(enabled) => void setOne(slot.vm, enabled)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card className='gap-5'>
        <CardHeader>
          <CardTitle className='text-base'>播种写什么</CardTitle>
          <p className='text-sm text-muted-foreground'>
            开关决定下面每个键的值。槽内这些键是锁定项，种子页的 extra_env
            改不动。
          </p>
        </CardHeader>
        <CardContent>
          <table className='w-full text-sm'>
            <thead>
              <tr className='text-left text-xs text-(--text-tertiary)'>
                <th className='hidden pb-2 font-medium sm:table-cell'>文件</th>
                <th className='pb-2 font-medium'>键</th>
                <th className='w-px pe-4 pb-2 font-medium'>开</th>
                <th className='w-px pb-2 font-medium'>关</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-[var(--hairline)]'>
              {CONTRACT.map((row) => {
                const flips = row.on !== row.off
                return (
                  <tr key={`${row.file}:${row.key}`}>
                    <td className='hidden py-2 pe-4 text-xs whitespace-nowrap text-muted-foreground sm:table-cell'>
                      {row.file}
                    </td>
                    <td className='py-2 pe-4'>
                      <div className='font-mono text-xs break-all text-foreground'>
                        {row.key}
                      </div>
                      <div className='mt-0.5 text-[11px] text-(--text-tertiary) sm:hidden'>
                        {row.file}
                      </div>
                    </td>
                    <td className='py-2 pe-4'>
                      <ValueChip value={row.on} accent={flips} />
                    </td>
                    <td className='py-2'>
                      <ValueChip value={row.off} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <ol className='mt-6 grid gap-px overflow-hidden rounded-lg bg-[var(--hairline)] sm:grid-cols-2 xl:grid-cols-4'>
            {steps.map((step, i) => (
              <li key={step.title} className='relative bg-card p-4'>
                <div className='flex items-center gap-2 text-sm font-medium'>
                  {step.title}
                  {i < steps.length - 1 ? (
                    <ArrowRight
                      aria-hidden
                      className='size-3.5 text-(--text-tertiary)'
                    />
                  ) : null}
                </div>
                <p className='mt-1.5 text-xs leading-5 text-muted-foreground'>
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card className='gap-0 py-0'>
        <ul className='divide-y divide-[var(--hairline)]'>
          <RelatedRow
            label='换票后同步遥测'
            detail='官方初装成功后，按官方身份把该槽遥测打开。'
            on={routing.isLoading ? null : official?.sync_telemetry === true}
            tab='init'
            tabLabel='初装'
          />
          <RelatedRow
            label='Codex analytics'
            detail='GPT 内核自己的统计上报，与上面的 Claude 旁路无关。'
            on={routing.isLoading ? null : codex?.analytics?.enabled === true}
            tab='openai'
            tabLabel='OpenAI'
          />
        </ul>
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={
          confirm ? '开启全部 Claude 槽的遥测？' : '关闭全部 Claude 槽的遥测？'
        }
        desc={
          <div className='space-y-2'>
            <p>
              依次重写 {pendingTargets.length} 个槽的种子文件
              {pendingRunning
                ? `；其中 ${pendingRunning} 个在运行，会重启遥测旁路，本机槽还会重启 kin-egress，正在走的请求可能断一次`
                : ''}
              。
            </p>
            {confirm ? (
              <p>
                没有官方初装身份的槽会写成开，但要等身份写入后才会上传。
                {pendingRemote
                  ? `其中 ${pendingRemote} 个是集群槽：集群节点不支持官方初装，开了也不会上传。`
                  : ''}
              </p>
            ) : null}
          </div>
        }
        cancelBtnText='取消'
        confirmText={confirm ? '开启' : '关闭'}
        destructive={confirm === false}
        handleConfirm={() => confirm !== null && void runBulk(confirm)}
      />
    </div>
  )
}

function FleetBar({
  counts,
  total,
}: {
  counts: (readonly [LiveKey, number])[]
  total: number
}) {
  return (
    <div
      role='img'
      aria-label={counts
        .filter(([, n]) => n)
        .map(([key, n]) => `${LIVE[key].legend} ${n}`)
        .join('，')}
      className='flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-[var(--track)]'
    >
      {total
        ? counts.map(([key, n]) =>
            n ? (
              <span
                key={key}
                className={cn(
                  'h-full first:rounded-s-full last:rounded-e-full motion-safe:transition-[flex-grow] motion-safe:duration-500 motion-safe:[transition-timing-function:var(--ease-out-expo)]',
                  LIVE[key].swatch
                )}
                style={{ flexGrow: n, flexBasis: 0 }}
              />
            ) : null
          )
        : null}
    </div>
  )
}

function Lamp({ live, probing }: { live: LiveKey; probing: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex size-2 shrink-0 rounded-full',
        LIVE[live].swatch,
        live === 'off' && 'bg-muted-foreground/40',
        probing && 'motion-safe:animate-pulse'
      )}
    >
      {live === 'live' ? (
        <span className='absolute inset-0 rounded-full bg-primary/70 motion-safe:animate-ping' />
      ) : null}
    </span>
  )
}

function SlotRow({
  slot,
  busy,
  locked,
  open,
  onToggleOpen,
  onSet,
}: {
  slot: SlotState
  busy: boolean
  locked: boolean
  open: boolean
  onToggleOpen: () => void
  onSet: (enabled: boolean) => void
}) {
  const { vm, on, live, label, probing } = slot
  const name = slotNameLabel(vm)
  const panelId = `telemetry-log-${vm.id}`
  return (
    <li>
      <div className='grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_10rem_auto] sm:px-6'>
        <button
          type='button'
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? '收起' : '展开'} ${vm.id} 上传记录`}
          onClick={onToggleOpen}
          className='-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        >
          <ChevronRight
            className={cn(
              'size-4 motion-safe:transition-transform motion-safe:duration-200',
              open && 'rotate-90'
            )}
          />
        </button>
        <div className='min-w-0'>
          <div className='flex min-w-0 items-baseline gap-2'>
            <span className='truncate text-sm font-medium'>{name}</span>
            <span className='shrink-0 font-mono text-xs text-muted-foreground'>
              {vm.id}
            </span>
          </div>
          <div className='mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden'>
            <Lamp live={live} probing={probing} />
            <span className={LIVE[live].text}>{label}</span>
          </div>
          {vm.node_name || vm.node_id ? (
            <div className='mt-0.5 truncate text-xs text-(--text-tertiary)'>
              节点 {vm.node_name || vm.node_id}
            </div>
          ) : null}
        </div>
        <div
          className='hidden items-center gap-2 text-xs sm:flex'
          title={
            live === 'blocked'
              ? vm.node_id
                ? '种子是开的，但这个集群槽没有官方初装身份，worker.json 保持关闭，旁路空转、不上传。集群节点槽目前不支持官方初装。'
                : '种子是开的，但 worker.json 没有官方初装身份，旁路空转、不上传。完成官方初装后会自动开始。'
              : live === 'idle'
                ? '开着但旁路进程没在跑，通常是旁路正在重启。'
                : undefined
          }
        >
          <Lamp live={live} probing={probing} />
          <span className={LIVE[live].text}>{label}</span>
        </div>
        <div
          role='group'
          aria-label={`${vm.id} 遥测开关`}
          className={cn(
            'inline-flex rounded-md border border-[var(--hairline)] bg-muted/40 p-0.5',
            busy && 'opacity-70'
          )}
        >
          {([true, false] as const).map((value) => {
            const active = on === value
            return (
              <button
                key={String(value)}
                type='button'
                aria-pressed={active}
                aria-label={`${value ? '开启' : '关闭'} ${vm.id} 遥测`}
                disabled={busy || locked || active}
                onClick={() => onSet(value)}
                className={cn(
                  'min-w-9 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default',
                  active
                    ? value
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-secondary text-foreground'
                    : 'text-muted-foreground enabled:hover:text-foreground'
                )}
              >
                {busy && !active ? '…' : value ? '开' : '关'}
              </button>
            )
          })}
        </div>
      </div>
      {open ? (
        <UploadPanel
          id={vm.id}
          panelId={panelId}
          on={on}
          remote={!!vm.node_id}
        />
      ) : null}
    </li>
  )
}

function UploadPanel({
  id,
  panelId,
  on,
  remote,
}: {
  id: string
  panelId: string
  on: boolean
  remote: boolean
}) {
  const log = useQuery({
    ...vmSeedUploadLogQueryOptions(id),
    refetchInterval: 10_000,
  })
  const summary = summarizeUploads(log.data || [])
  const now = Date.now()
  return (
    <div
      id={panelId}
      className='animate-settings-pane-in space-y-3 border-t border-[var(--hairline)] bg-muted/25 px-4 py-4 sm:ps-13 sm:pe-6'
    >
      {log.isLoading ? (
        <p className='text-xs text-muted-foreground'>读取上传记录…</p>
      ) : log.error ? (
        <p className='text-xs text-destructive'>
          读不到上传记录：{(log.error as Error).message}
        </p>
      ) : summary.entries.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          {remote
            ? '集群槽的上传记录写在节点上，面板目前读不到。'
            : on
              ? '还没有上传记录。有会话活动后旁路开始上传，这里会出现。'
              : '遥测关着，没有上传记录。'}
        </p>
      ) : (
        <>
          <dl className='flex flex-wrap gap-x-6 gap-y-1 text-xs'>
            <Stat label='最后上传'>
              {summary.last ? relativeAgo(summary.last, now) : '—'}
            </Stat>
            <Stat label='批次'>{summary.batch}</Stat>
            <Stat label='GrowthBook'>{summary.evals}</Stat>
            <Stat label='失败' tone={summary.failed ? 'bad' : undefined}>
              {summary.failed}
            </Stat>
            <span className='text-(--text-tertiary)'>
              最近 {summary.entries.length} 条
            </span>
          </dl>
          <Timeline
            entries={summary.entries}
            first={summary.first}
            last={summary.last}
          />
          <details className='group'>
            <summary className='inline-flex cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'>
              <ChevronRight className='size-3.5 group-open:rotate-90 motion-safe:transition-transform' />
              原始记录（身份字段已剔除）
            </summary>
            <pre className='mt-2 max-h-64 overflow-auto rounded-md bg-background/60 px-3 py-2 font-mono text-[11px] leading-5 text-foreground'>
              {[...(log.data || [])].reverse().join('\n')}
            </pre>
          </details>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  tone,
  children,
}: {
  label: string
  tone?: 'bad'
  children: React.ReactNode
}) {
  return (
    <div className='flex items-baseline gap-1.5'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd
        className={cn(
          'font-mono tabular-nums',
          tone === 'bad' ? 'text-[var(--status-bad)]' : 'text-foreground'
        )}
      >
        {children}
      </dd>
    </div>
  )
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

function Timeline({
  entries,
  first,
  last,
}: {
  entries: UploadEntry[]
  first: number | null
  last: number | null
}) {
  if (first === null || last === null) return null
  const span = last - first
  return (
    <div>
      <div className='relative h-7 rounded-md bg-background/50'>
        <span
          aria-hidden
          className='absolute inset-x-2 top-1/2 h-px bg-[var(--hairline)]'
        />
        {entries.map((entry, i) => {
          const x = span > 0 ? (entry.at - first) / span : 0.5
          return (
            <span
              key={`${entry.at}:${i}`}
              title={`${clock(entry.at)} · ${entry.kind}${entry.name ? ` ${entry.name}` : ''} · ${entry.state}`}
              className={cn(
                'absolute top-1/2 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full',
                !entry.ok
                  ? 'h-5 bg-[var(--status-bad)]'
                  : entry.kind === 'eval'
                    ? 'h-5 bg-[var(--chart-2)]'
                    : 'h-3 bg-primary'
              )}
              style={{ left: `calc(0.5rem + ${x} * (100% - 1rem))` }}
            />
          )
        })}
      </div>
      <div className='mt-1 flex items-center justify-between font-mono text-[11px] text-(--text-tertiary) tabular-nums'>
        <span>{clock(first)}</span>
        <span className='flex items-center gap-3 font-sans'>
          <Key swatch='bg-primary' label='批次' />
          <Key swatch='bg-[var(--chart-2)]' label='GrowthBook' />
          <Key swatch='bg-[var(--status-bad)]' label='失败' />
        </span>
        <span>{clock(last)}</span>
      </div>
    </div>
  )
}

function Key({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className='inline-flex items-center gap-1'>
      <span aria-hidden className={cn('h-2.5 w-[3px] rounded-full', swatch)} />
      {label}
    </span>
  )
}

function ValueChip({ value, accent }: { value: string; accent?: boolean }) {
  const literal = /^(".*"|true|false|enabled|disabled)/.test(value)
  return (
    <span
      className={cn(
        'inline-flex rounded px-1.5 py-0.5 text-xs whitespace-nowrap',
        literal ? 'font-mono' : '',
        accent
          ? 'bg-accent text-accent-foreground'
          : 'bg-muted text-muted-foreground'
      )}
    >
      {value}
    </span>
  )
}

function RelatedRow({
  label,
  detail,
  on,
  tab,
  tabLabel,
}: {
  label: string
  detail: string
  on: boolean | null
  tab: 'init' | 'openai'
  tabLabel: string
}) {
  return (
    <li className='flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5 sm:px-6'>
      <div className='min-w-48 flex-1'>
        <div className='text-sm font-medium'>{label}</div>
        <p className='text-xs text-muted-foreground'>{detail}</p>
      </div>
      <span
        className={cn(
          'font-mono text-xs',
          on ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {on === null ? '…' : on ? '开' : '关'}
      </span>
      <Link
        to='/settings/$tab'
        params={{ tab }}
        className='inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
      >
        在「{tabLabel}」修改
        <ArrowRight className='size-3' aria-hidden />
      </Link>
    </li>
  )
}
