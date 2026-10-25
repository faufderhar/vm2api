import { useState } from 'react'
import type { PhysicalFactKey, Vm, VmPhysicalFeatures } from '@/types/panel-vm'
import { fmtAgo, fmtBytes, fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field } from '@/features/vm/detail-section-primitives'
import {
  NOT_COLLECTED_TEXT,
  START_AND_COLLECT_CONFIRM,
  canStartAndCollect,
  collectErrorView,
  factSourceBadge,
  guestOnlyEmpty,
  physicalBanner,
} from '@/features/vm/physical-features-view'

function dash(value: unknown, empty = NOT_COLLECTED_TEXT) {
  if (value == null) return empty
  const text = String(value).trim()
  return text ? text : empty
}

function Mono({ children }: { children: string }) {
  return <span className='font-mono text-xs'>{children}</span>
}

function SourceBadge({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <span className='ms-1.5 rounded border px-1 py-px text-[10px] text-muted-foreground'>
      {text}
    </span>
  )
}

function Fact({
  label,
  value,
  empty = NOT_COLLECTED_TEXT,
  badge = null,
}: {
  label: string
  value: unknown
  empty?: string
  badge?: string | null
}) {
  const text = dash(value, empty)
  return (
    <Field label={label}>
      {text === empty ? (
        <span className='text-muted-foreground'>{empty}</span>
      ) : (
        <span>
          <Mono>{text}</Mono>
          <SourceBadge text={badge} />
        </span>
      )}
    </Field>
  )
}

function osLabel(features: VmPhysicalFeatures) {
  const pretty = dash(features.os_pretty, '')
  const id = dash(features.os_id, '')
  if (pretty && id && pretty !== id) return `${pretty} (${id})`
  return pretty || id || null
}

function memoryLabel(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return null
  return fmtBytes(bytes)
}

function observedLabel(at: string | null | undefined) {
  const abs = fmtExpiresAt(at)
  if (!at || abs === '—') return null
  const ago = fmtAgo(at)
  return ago ? `${abs} · ${ago}` : abs
}

export function VmPhysicalFeaturesCard({
  vm,
  collecting = false,
  starting = false,
  onCollect,
  onStartAndCollect,
}: {
  vm: Vm
  collecting?: boolean
  starting?: boolean
  onCollect: () => void
  /** 开机后再采集；只在没有运行中容器的槽上显示。 */
  onStartAndCollect?: () => void
}) {
  const [confirmStart, setConfirmStart] = useState(false)
  const features = vm.physical_features || {}
  const dmi = features.dmi || {}
  const guestEmpty = guestOnlyEmpty(features)
  const badge = (key: PhysicalFactKey) => factSourceBadge(features, key)
  const banner = physicalBanner(vm)
  const failure = collectErrorView(features)
  const showStart = !!onStartAndCollect && canStartAndCollect(vm)
  const failedAt = failure?.at ? observedLabel(failure.at) : null
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <CardTitle className='text-sm'>物理特征</CardTitle>
        <div className='flex gap-2'>
          {showStart ? (
            <Button
              size='sm'
              variant='outline'
              className='h-7'
              loading={starting}
              disabled={collecting}
              onClick={() => setConfirmStart(true)}
            >
              开机并采集
            </Button>
          ) : null}
          <Button
            size='sm'
            variant='outline'
            className='h-7'
            loading={collecting}
            disabled={starting}
            onClick={onCollect}
          >
            采集
          </Button>
        </div>
      </CardHeader>
      <CardContent className='divide-y pt-0'>
        {failure ? (
          <div
            role='alert'
            data-testid='physical-collect-error'
            className='mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive'
          >
            <div className='font-medium'>
              上次采集失败{failedAt ? `（${failedAt}）` : ''}
            </div>
            <div className='break-all'>{failure.message}</div>
          </div>
        ) : null}
        {banner ? (
          <p className='pb-2 text-xs text-muted-foreground'>{banner}</p>
        ) : null}
        <Fact
          label='形态'
          value={features.runtime_type || vm.runtime_type}
          empty='—'
        />
        <Fact
          label='采集时间'
          value={observedLabel(features.observed_at)}
          empty={guestEmpty}
        />
        <Fact
          label='主机名'
          value={features.hostname}
          badge={badge('hostname')}
        />
        <Fact label='系统' value={osLabel(features)} empty={guestEmpty} />
        <Fact label='内核' value={features.kernel_release} empty={guestEmpty} />
        <Fact label='架构' value={features.arch} empty={guestEmpty} />
        <Fact
          label='CPU'
          value={features.cpu_model}
          badge={badge('cpu_model')}
        />
        <Fact
          label='核数'
          value={features.cpu_cores}
          badge={badge('cpu_cores')}
        />
        <Fact
          label='内存'
          value={memoryLabel(features.memory_bytes)}
          badge={badge('memory_bytes')}
        />
        <Fact
          label='磁盘'
          value={features.root_disk}
          empty={guestEmpty}
          badge={badge('root_disk')}
        />
        <Fact label='MAC' value={features.mac} badge={badge('mac')} />
        <Fact label='厂商' value={dmi.manufacturer} badge={badge('dmi')} />
        <Fact label='产品' value={dmi.product} badge={badge('dmi')} />
        <Fact label='版本' value={dmi.version} badge={badge('dmi')} />
        <Fact label='系列' value={dmi.family} badge={badge('dmi')} />
        <Fact label='序列号' value={dmi.serial} badge={badge('dmi')} />
        <Fact label='UUID' value={dmi.uuid} badge={badge('dmi')} />
        <Fact label='Shell' value={features.shell} empty={guestEmpty} />
        <Fact
          label='包管理'
          value={features.package_managers}
          empty={guestEmpty}
        />
        <Fact label='工具链' value={features.runtimes} empty={guestEmpty} />
        <Fact label='时区' value={features.timezone} />
        <Fact label='区域' value={features.locale} />
        <Field label='machine-id'>
          {features.machine_id_present ? (
            <span>
              <Mono>有</Mono>
              <SourceBadge text={badge('machine_id')} />
            </span>
          ) : (
            <span className='text-muted-foreground'>
              {features.observed_at ? '无' : guestEmpty}
            </span>
          )}
        </Field>
      </CardContent>
      {onStartAndCollect ? (
        <ConfirmDialog
          open={confirmStart}
          onOpenChange={setConfirmStart}
          title='开机并采集'
          desc={START_AND_COLLECT_CONFIRM}
          cancelBtnText='取消'
          confirmText='开机并采集'
          isLoading={starting}
          handleConfirm={() => {
            setConfirmStart(false)
            onStartAndCollect()
          }}
        />
      ) : null}
    </Card>
  )
}
