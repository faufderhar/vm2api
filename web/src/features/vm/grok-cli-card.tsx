import type { VmGrokCliInfo } from '@/types/panel-vm'
import { fmtAgo, fmtExpiresAt } from '@/lib/format'
import { cn } from '@/lib/utils'

const KERNEL_REASON: Record<string, string> = {
  token_missing: '内核令牌未生成',
  timeout: '健康检查超时',
  ENOENT: '内核未运行',
  ECONNREFUSED: '内核未运行',
}

function Row({
  name,
  value,
  note,
}: {
  name: string
  value: string | null | undefined
  note?: string
}) {
  const text = String(value ?? '').trim()
  return (
    <div className='grid items-baseline gap-2 px-4 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,24rem)]'>
      <span className='font-mono text-xs font-medium break-all'>{name}</span>
      <span className='min-w-0 font-mono text-xs break-all'>
        {text ? text : <span className='text-muted-foreground'>—</span>}
        {note ? <span className='text-muted-foreground'> · {note}</span> : null}
      </span>
    </div>
  )
}

function atLabel(value: unknown) {
  const abs = fmtExpiresAt(value)
  if (abs === '—') return ''
  const ago = fmtAgo(value)
  return ago ? `${abs} · ${ago}` : abs
}

function kernelState(kernel: VmGrokCliInfo['kernel']) {
  if (!kernel.configured) {
    return {
      tone: 'idle',
      title: '内核未配置',
      detail: '槽位还没起过推理，首个请求或启动时写入',
    }
  }
  if (kernel.ok) {
    return {
      tone: 'ok',
      title: '内核运行中',
      detail: kernel.in_flight ? `${kernel.in_flight} 个请求进行中` : '空闲',
    }
  }
  return {
    tone: 'bad',
    title: '内核未就绪',
    detail:
      KERNEL_REASON[kernel.reason] || kernel.reason || '下个请求会自动拉起',
  }
}

/**
 * Grok 槽的「种子」：容器里没有 Grok CLI，推理由本机 kin-grok-kernel
 * 以 grok-shell 的身份发出。这里只读展示它对上游呈现的客户端信息。
 */
export function GrokCliCard({ info }: { info: VmGrokCliInfo }) {
  const state = kernelState(info.kernel)
  const cred = info.credentials
  return (
    <div className='grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]'>
      <section className='min-w-0 overflow-hidden rounded-xl border bg-card'>
        <header className='flex items-baseline justify-between gap-3 border-b px-4 py-3'>
          <h2 className='text-sm font-semibold'>Grok CLI</h2>
          <p className='font-mono text-[11px] text-muted-foreground'>
            {info.product} {info.client_version} · 只读
          </p>
        </header>
        <div className='divide-y'>
          <Row name='client' value={info.product} />
          <Row name='x-grok-client-version' value={info.client_version} />
          <Row name='User-Agent' value={info.user_agent} />
          <Row
            name='x-grok-client-mode'
            value={info.billing_client_mode}
            note='仅账单请求'
          />
          <Row name='x-grok-agent-id' value={info.agent_id} note='槽位固定' />
          <Row name='base_url' value={info.base_url} />
          <Row name='oauth.client_id' value={info.oauth.client_id} />
          <Row name='oauth.discovery' value={info.oauth.discovery_url} />
          <Row
            name='oauth.token_url'
            value={info.oauth.token_url}
            note={info.oauth.token_url ? undefined : '按 discovery 解析'}
          />
          <Row
            name='refresh_skew'
            value={`${info.oauth.refresh_skew_sec}s`}
            note='提前刷新'
          />
          <Row
            name='proxy'
            value={info.proxy.url}
            note={
              info.proxy.url
                ? info.proxy.auth
                  ? '带认证'
                  : undefined
                : info.proxy.required === false
                  ? '本机出口直连'
                  : undefined
            }
          />
        </div>
      </section>

      <section className='min-w-0 overflow-hidden rounded-xl border bg-card'>
        <header className='flex items-center gap-3 border-b px-4 py-3'>
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              state.tone === 'ok'
                ? 'bg-[color:var(--status-ok-solid)]'
                : state.tone === 'bad'
                  ? 'bg-[color:var(--status-warn-solid)]'
                  : 'bg-muted-foreground/50'
            )}
          />
          <div className='min-w-0'>
            <h2 className='text-sm font-semibold'>{state.title}</h2>
            <p className='text-xs text-muted-foreground'>{state.detail}</p>
          </div>
        </header>
        <div className='divide-y'>
          <Row
            name='配置写入'
            value={atLabel(info.kernel.config_written_at) || null}
          />
          <Row
            name='凭证'
            value={
              cred.present
                ? [
                    cred.has_access ? 'access' : '',
                    cred.has_refresh ? 'refresh' : '',
                  ]
                    .filter(Boolean)
                    .join(' + ') || '空'
                : '未导入'
            }
          />
          <Row name='过期' value={atLabel(cred.expires_at) || null} />
          <Row name='凭证更新' value={atLabel(cred.updated_at) || null} />
        </div>
        <p className='border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground'>
          Grok 槽没有 Claude 的 settings.json、claude.setting
          和遥测。客户端身份由本机内核按 grok-shell
          固定发送，版本随网关升级，不按槽播种。
        </p>
      </section>
    </div>
  )
}
