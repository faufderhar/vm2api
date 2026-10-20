import { fmtBytes, fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { StatusMark } from '@/components/status-mark'
import {
  formatNodeMetric,
  isLiveLink,
  LINK_LATENCY_WARN_MS,
  LINK_STATE_TEXT,
  LINK_TONE,
  directLinkText,
  type ClusterNode,
} from '@/features/cluster/model'
import { PanelCard } from '@/features/overview/panel-card'

const HOST_HOT_PCT = 85

const COL = {
  name: 'min-w-[108px] flex-[1.1] pl-3',
  host: 'min-w-[132px] flex-[1.3]',
  link: 'min-w-[160px] flex-[1.1] whitespace-nowrap',
  metric: 'min-w-[64px] flex-[0.7] text-right',
  spend: 'min-w-[88px] flex-[0.9] pr-2 text-right',
  action: 'w-28 shrink-0 pr-2 text-right',
}

export function RemoteList({
  nodes,
  onJoin,
  onOpen,
  onDisconnect,
  canManage,
}: {
  nodes: ClusterNode[]
  onJoin: () => void
  onOpen: (node: ClusterNode) => void
  onDisconnect: (node: ClusterNode) => void
  canManage: boolean
}) {
  return (
    <PanelCard
      title='扩展节点'
      meta='SSH 接入的 VPS，远端 Docker 经同一条连接管理'
      action={
        canManage ? (
          <Button size='sm' variant='outline' onClick={onJoin}>
            接入
          </Button>
        ) : undefined
      }
    >
      {nodes.length === 0 ? (
        <EmptyState
          reason='还没有扩展节点。用 SSH 接入一台 VPS，在面板里管理它的终端和 Docker。'
          actionLabel={canManage ? '接入 VPS' : undefined}
          onAction={canManage ? onJoin : undefined}
        />
      ) : (
        <div className='overflow-x-auto'>
          <div className='min-w-[1064px]'>
            <div className='flex h-8 items-center border-b bg-muted/30 text-[11px] font-medium tracking-wide text-muted-foreground/80'>
              <div className={COL.name}>节点</div>
              <div className={COL.host}>IP</div>
              <div className={COL.link}>链路</div>
              <div className={COL.metric}>CPU</div>
              <div className={COL.metric}>内存</div>
              <div
                className={COL.metric}
                title='全部容器内存合计（不含文件缓存）'
              >
                容器
              </div>
              <div className={COL.metric} title='运行中 / 全部容器（含出口）'>
                Docker
              </div>
              <div className={COL.metric}>槽位</div>
              <div className={COL.metric}>凭证</div>
              <div className={COL.metric}>在线</div>
              <div className={COL.spend}>花费</div>
              <div className={COL.action} />
            </div>
            {nodes.map((node) => {
              const live = isLiveLink(node.link)
              const lat =
                live && node.latencyMs != null
                  ? `${Math.round(node.latencyMs)}ms`
                  : ''
              const latHot =
                live &&
                node.latencyMs != null &&
                node.latencyMs > LINK_LATENCY_WARN_MS
              const hs = live ? node.remote?.health?.host : null
              return (
                <div
                  key={node.id}
                  className='flex h-9 items-center border-b border-border/40 text-sm last:border-b-0 hover:bg-muted/50'
                >
                  <div
                    className={cn(
                      COL.name,
                      'flex min-w-0 items-center gap-1.5'
                    )}
                  >
                    <span className='truncate font-medium' title={node.label}>
                      {node.label}
                    </span>
                  </div>
                  <div
                    className={cn(COL.host, 'field-host truncate text-xs')}
                    title={node.host}
                  >
                    {node.host}
                  </div>
                  <div className={cn(COL.link, 'flex items-center gap-1.5')}>
                    <StatusMark tone={LINK_TONE[node.link]} />
                    {node.remote ? (
                      <span className='text-xs'>
                        {LINK_STATE_TEXT[node.remote.link.state]}
                      </span>
                    ) : null}
                    {live && node.remote?.direct_link ? (
                      <span
                        className={cn(
                          'rounded border px-1 text-[10px] leading-4',
                          node.remote.direct_link.state === 'ok'
                            ? 'border-primary/40 text-primary'
                            : 'border-caution-3/50 text-caution-3'
                        )}
                        title={`直连通道：${directLinkText(node.remote.direct_link)}`}
                      >
                        {node.remote.direct_link.state === 'ok'
                          ? '直连'
                          : '直连→SSH'}
                      </span>
                    ) : null}
                    {lat ? (
                      <span
                        className={cn(
                          'field-metric shrink-0 text-[11px]',
                          latHot ? 'text-caution-3' : 'text-muted-foreground'
                        )}
                      >
                        {lat}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      COL.metric,
                      'field-metric',
                      hs && hs.cpu_pct >= HOST_HOT_PCT && 'text-caution-3'
                    )}
                    title={
                      hs
                        ? `${hs.cpu_count} 核 · load ${[hs.load1, hs.load5, hs.load15].map((n) => (n == null ? '—' : n.toFixed(2))).join(' / ')}`
                        : undefined
                    }
                  >
                    {hs ? `${hs.cpu_pct.toFixed(0)}%` : '—'}
                  </div>
                  <div
                    className={cn(
                      COL.metric,
                      'field-metric',
                      hs && hs.mem_pct >= HOST_HOT_PCT && 'text-caution-3'
                    )}
                    title={
                      hs
                        ? `${fmtBytes(hs.mem_used)} / ${fmtBytes(hs.mem_total)}`
                        : undefined
                    }
                  >
                    {hs ? `${hs.mem_pct.toFixed(0)}%` : '—'}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {hs?.containers_mem != null
                      ? fmtBytes(hs.containers_mem)
                      : '—'}
                  </div>
                  <div
                    className={cn(COL.metric, 'field-metric')}
                    title={
                      node.docker
                        ? `运行 ${node.docker.running} / 共 ${node.docker.total} 个容器`
                        : undefined
                    }
                  >
                    {isLiveLink(node.link) && node.docker
                      ? `${fmtNum(node.docker.running)}/${fmtNum(node.docker.total)}`
                      : '—'}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.vmCount, fmtNum)}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.credCount, fmtNum)}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.onlineCredCount, fmtNum)}
                  </div>
                  <div className={cn(COL.spend, 'field-metric')}>
                    {formatNodeMetric(node, node.spendUsd, (n) => fmtUsd(n, 2))}
                  </div>
                  <div className={COL.action}>
                    {canManage ? (
                      <>
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-7 px-2 text-xs'
                          onClick={() => onOpen(node)}
                        >
                          管理
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-7 px-2 text-xs'
                          onClick={() => onDisconnect(node)}
                        >
                          移除
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </PanelCard>
  )
}
