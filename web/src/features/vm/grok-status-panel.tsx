import type { GrokBuildUsage, Vm } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { fmtAgo, fmtUsd } from '@/lib/format'
import { grokAuthErrorText, grokStateOf } from '@/lib/vm-kind'
import { grokPlanLabel, grokSubscriptionTier } from '@/lib/vm-status'
import { Field, ResetAt } from '@/features/vm/detail-section-primitives'

const GROK_BUILD_ERROR: Record<string, string> = {
  upstream_auth: 'Grok Build 账单需要重新登录',
  upstream_error: 'Grok Build 账单请求失败',
  billing_unparsed: 'Grok Build 账单里没有用量',
  timeout: 'Grok Build 用量请求超时',
  fetch_failed: 'Grok Build 用量请求失败',
  proxy_required: 'Grok 槽未绑定出口',
  grok_no_credential: 'Grok 凭证不可用，请重新导入',
}

function yesNo(value: boolean | undefined) {
  return value ? '有' : '无'
}

function grokBuildSyncError(usage: GrokBuildUsage | null | undefined) {
  if (!usage || usage.ok !== false) return ''
  const message = String(usage.message || '').trim()
  if (message) return message
  const code = String(usage.error || '').trim()
  return GROK_BUILD_ERROR[code] || code || 'Grok Build 用量同步失败'
}

export function GrokStatusPanel({ vm, now }: { vm: Vm; now: number }) {
  const grok = grokStateOf(vm)
  const authError = grokAuthErrorText(vm)
  const limitedUntil = expiresAtToMs(grok.limited_until)
  const limited = limitedUntil > now
  const expiresAt = grok.expires_at ?? vm.expires_at
  const lastRefresh = grok.last_refresh_at
  const lastRefreshMs = expiresAtToMs(lastRefresh)
  const usage = grok.build_usage
  const tier = grokSubscriptionTier(vm)
  const weekly = usage?.credit_usage_percent
  const syncError = grokBuildSyncError(usage)
  const probedAt = expiresAtToMs(usage?.probed_at)
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
      {syncError ? (
        <div className='rounded-md border border-[color:var(--status-caution)]/40 px-3 py-2 text-xs'>
          <div className='font-medium text-[color:var(--status-caution)]'>
            Grok Build 用量同步失败
          </div>
          <div className='mt-0.5 break-all text-muted-foreground'>
            {syncError}
          </div>
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
        <Field label='订阅档' compact>
          {tier ? (
            <>
              {grokPlanLabel(tier)}
              {grokPlanLabel(tier) !== tier ? (
                <span className='ml-1.5 font-mono text-xs text-muted-foreground'>
                  {tier}
                </span>
              ) : null}
            </>
          ) : (
            '—'
          )}
        </Field>
        <Field label='周额度' compact>
          {weekly == null ? '未同步' : `${Number(weekly).toFixed(0)}%`}
        </Field>
        <Field label='周额度重置' compact>
          {usage?.period_end ? (
            <ResetAt value={usage.period_end} now={now} />
          ) : (
            '—'
          )}
        </Field>
        <Field label='月包含额度' compact>
          {usage?.monthly_limit == null
            ? '—'
            : `${fmtUsd(usage.included_used || 0)} / ${fmtUsd(usage.monthly_limit)}`}
        </Field>
        <Field label='预存余额' compact>
          {usage?.prepaid_balance == null ? '—' : fmtUsd(usage.prepaid_balance)}
        </Field>
        <Field label='上次同步' compact>
          {probedAt
            ? fmtAgo(new Date(probedAt).toISOString(), now) ||
              new Date(probedAt).toLocaleString()
            : '尚未同步'}
        </Field>
      </div>
      <p className='text-xs text-muted-foreground'>
        用量来自 Grok Build 账单。周额度是共享用量池，不是 5
        小时窗口。限流仍以上游 429 为准。
        {syncError ? ' 同步失败时仍显示上一次成功的数字。' : ''}
      </p>
    </div>
  )
}
