import { CalendarClock } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { fmtIdle, resetIdleOptions, resetPriorityView } from './reset-priority'
import { ChipGroup, PaneSection } from './scheduler-controls'

type Block = Record<string, unknown>

/** GPT / Grok 设置页的「优先使用临近重置的账号」分区。 */
export function ResetPrioritySection({
  block,
  onChange,
  resetLabel,
  defaultIdleSec,
  idleReason,
  resetNote,
  saving = false,
  label,
}: {
  block: Block
  /** 只回传两项平铺字段，调用方合并进自己的段。 */
  onChange: (patch: Block) => void
  /** 例如「7 天额度窗口」「Grok Build 周额度重置」。 */
  resetLabel: string
  defaultIdleSec: number
  /** 默认空闲时间的来由，一句话。 */
  idleReason: string
  /** 补充说明重置时间的来源，可选。 */
  resetNote?: string
  saving?: boolean
  /** 无障碍名前缀，例如 GPT / Grok。 */
  label: string
}) {
  const view = resetPriorityView(block, defaultIdleSec)
  return (
    <PaneSection
      icon={CalendarClock}
      title='优先使用临近重置的账号'
      desc={`${resetLabel}越早重置的账号越先用；剩余额度不足 5%、没有重置数据或重置时间已过的账号按原顺序。槽位权重分档仍然优先，限流、冷却、停用的账号照旧不参与。${resetNote ? ` ${resetNote}` : ''}`}
      aside={
        <Switch
          checked={view.enabled}
          disabled={saving}
          onCheckedChange={(next) => onChange({ reset_priority: next })}
          aria-label={`${label} 优先使用临近重置的账号`}
        />
      }
    >
      <div className='divide-y'>
        <SettingRow
          label='会话空闲多久后可换号'
          desc={`进行中的会话不换号，续写已存储的回复（previous_response_id）也不换；空闲超过此时间后，下一次请求按重置顺序重新选号。默认 ${fmtIdle(defaultIdleSec)}：${idleReason}`}
        >
          <ChipGroup
            label={`${label} 会话空闲多久后可换号`}
            value={view.idleSec}
            options={resetIdleOptions(view.idleSec)}
            disabled={saving || !view.enabled}
            onChange={(sec) => onChange({ reset_priority_idle_sec: sec })}
          />
        </SettingRow>
      </div>
    </PaneSection>
  )
}
