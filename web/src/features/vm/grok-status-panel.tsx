import type { Vm } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { fmtAgo } from '@/lib/format'
import { grokAuthErrorText, grokStateOf } from '@/lib/vm-kind'
import { Field, ResetAt } from '@/features/vm/detail-section-primitives'

function yesNo(value: boolean | undefined) {
  return value ? '有' : '无'
}

export function GrokStatusPanel({ vm, now }: { vm: Vm; now: number }) {
  const grok = grokStateOf(vm)
  const authError = grokAuthErrorText(vm)
  const limitedUntil = expiresAtToMs(grok.limited_until)
  const limited = limitedUntil > now
  const expiresAt = grok.expires_at ?? vm.expires_at
  const lastRefresh = grok.last_refresh_at
  const lastRefreshMs = expiresAtToMs(lastRefresh)
  return (
    <div className='space-y-3'>
      {authError ? (
        <div className='rounded-md border border-[color:var(--status-bad)]/40 px-3 py-2 text-xs text-[color:var(--status-bad)]'>
          <div className='font-medium'>授权失效，需要重新导入</div>
          <div className='mt-0.5 break-all'>{authError}</div>
          {grok.auth_error?.at ? (
            <div className='mt-0.5 text-muted-foreground'>
              <ResetAt value={grok.auth_error.at} now={now} />
            </div>
          ) : null}
        </div>
      ) : null}
      {limited ? (
        <div className='rounded-md border border-[color:var(--status-caution)]/40 px-3 py-2 text-xs'>
          <div className='font-medium text-[color:var(--status-caution)]'>
            上游限流中
          </div>
          {grok.limited_reason ? (
            <div className='mt-0.5 break-all text-muted-foreground'>
              {grok.limited_reason}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className='divide-y'>
        <Field label='账号 ID' compact>
          <span className='font-mono text-xs break-all'>
            {grok.account_id || vm.org_uuid || '—'}
          </span>
        </Field>
        <Field label='Access' compact>
          {yesNo(grok.has_access ?? vm.has_token)}
        </Field>
        <Field label='Refresh' compact>
          {yesNo(grok.has_refresh ?? vm.has_refresh)}
        </Field>
        <Field label='Token 到期' compact>
          <ResetAt value={expiresAt} now={now} />
        </Field>
        <Field label='限流至' compact>
          {limited ? <ResetAt value={grok.limited_until} now={now} /> : '—'}
        </Field>
        <Field label='上次刷新' compact>
          {lastRefreshMs
            ? fmtAgo(new Date(lastRefreshMs).toISOString(), now) ||
              new Date(lastRefreshMs).toLocaleString()
            : '—'}
        </Field>
      </div>
      <p className='text-xs text-muted-foreground'>
        xAI 不公开 5h / 7d 用量窗口；限流以上游返回为准。
      </p>
    </div>
  )
}
