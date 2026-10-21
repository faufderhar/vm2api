import type { Vm, VmPhysicalFeatures } from '@/types/panel-vm'
import { fmtAgo, fmtBytes, fmtExpiresAt } from '@/lib/format'
import { isClaudeVm, isGrokVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/features/vm/detail-section-primitives'

function dash(value: unknown, empty = '未采集') {
  if (value == null) return empty
  const text = String(value).trim()
  return text ? text : empty
}

function Mono({ children }: { children: string }) {
  return <span className='font-mono text-xs'>{children}</span>
}

function Fact({
  label,
  value,
  empty = '未采集',
}: {
  label: string
  value: unknown
  empty?: string
}) {
  const text = dash(value, empty)
  return (
    <Field label={label}>
      {text === empty ? (
        <span className='text-muted-foreground'>{empty}</span>
      ) : (
        <Mono>{text}</Mono>
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
  onCollect,
}: {
  vm: Vm
  collecting?: boolean
  onCollect: () => void
}) {
  const features = vm.physical_features || {}
  const dmi = features.dmi || {}
  const isHeadless = !isClaudeVm(vm)
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <CardTitle className='text-sm'>物理特征</CardTitle>
        <Button
          size='sm'
          variant='outline'
          className='h-7'
          loading={collecting}
          onClick={onCollect}
        >
          采集
        </Button>
      </CardHeader>
      <CardContent className='divide-y pt-0'>
        {!features.observed_at && isHeadless ? (
          <p className='pb-2 text-xs text-muted-foreground'>
            {isGrokVm(vm) ? 'Grok' : 'GPT'}
            槽导入凭证时不跑官方初装，不会自动采集。点「采集」读取容器里的系统、内核和工具链。
          </p>
        ) : null}
        <Fact
          label='形态'
          value={features.runtime_type || vm.runtime_type}
          empty='—'
        />
        <Fact label='采集时间' value={observedLabel(features.observed_at)} />
        <Fact label='主机名' value={features.hostname} />
        <Fact label='系统' value={osLabel(features)} />
        <Fact label='内核' value={features.kernel_release} />
        <Fact label='架构' value={features.arch} />
        <Fact label='CPU' value={features.cpu_model} />
        <Fact label='核数' value={features.cpu_cores} />
        <Fact label='内存' value={memoryLabel(features.memory_bytes)} />
        <Fact label='磁盘' value={features.root_disk} />
        <Fact label='MAC' value={features.mac} />
        <Fact label='厂商' value={dmi.manufacturer} />
        <Fact label='产品' value={dmi.product} />
        <Fact label='版本' value={dmi.version} />
        <Fact label='系列' value={dmi.family} />
        <Fact label='序列号' value={dmi.serial} />
        <Fact label='UUID' value={dmi.uuid} />
        <Fact label='Shell' value={features.shell} />
        <Fact label='包管理' value={features.package_managers} />
        <Fact label='工具链' value={features.runtimes} />
        <Fact label='时区' value={features.timezone} />
        <Fact label='区域' value={features.locale} />
        <Field label='machine-id'>
          {features.machine_id_present ? (
            <Mono>有</Mono>
          ) : (
            <span className='text-muted-foreground'>
              {features.observed_at ? '无' : '未采集'}
            </span>
          )}
        </Field>
      </CardContent>
    </Card>
  )
}
