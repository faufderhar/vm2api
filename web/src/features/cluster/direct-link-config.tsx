import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ClusterApiNode } from '@/types/panel-cluster'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { directLinkText } from './model'
import { CLUSTER_NODES_KEY } from './queries'

const DEFAULT_PORT = 7790
// 只用来预填：SSH 地址本身是 IP 时直接沿用，主机名留空让人填（服务端只收 IP）。
const looksLikeIp = (s: string) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':')

/** 槽位流量经 TLS 直连节点上的 kin-slot-gate，每个请求一条 TCP；不通时自动走 SSH。 */
export function DirectLinkConfig({ node }: { node: ClusterApiNode }) {
  const qc = useQueryClient()
  const link = node.direct_link || null
  const [address, setAddress] = useState(
    link?.address || (looksLikeIp(node.host) ? node.host : '')
  )
  const [port, setPort] = useState(link ? String(link.port) : '')
  const path = `/api/panel/cluster/nodes/${encodeURIComponent(node.id)}/direct-link`
  const done = () => qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
  const save = useMutation({
    mutationFn: () =>
      api<ClusterApiNode>(path, {
        method: 'PUT',
        body: JSON.stringify({
          address: address.trim(),
          port: port.trim() || DEFAULT_PORT,
        }),
      }),
    onSuccess: (saved) => {
      const next = saved.direct_link
      if (next?.state === 'ok') toast.success('直连通道已生效')
      else toast.warning(`已保存，${directLinkText(next)}`)
      done()
    },
    onError: (err) => toast.error(err.message),
  })
  const clear = useMutation({
    mutationFn: () => api(path, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('已关闭直连通道，槽位流量改走 SSH')
      setAddress('')
      setPort('')
      done()
    },
    onError: (err) => toast.error(err.message),
  })
  const busy = save.isPending || clear.isPending
  return (
    <section className='space-y-3 border-t pt-4'>
      <div className='flex items-baseline justify-between gap-2'>
        <h3 className='text-sm font-medium'>直连通道</h3>
        <span className='text-xs text-muted-foreground'>
          {directLinkText(link)}
        </span>
      </div>
      <p className='text-xs text-muted-foreground'>
        槽位请求改为每次一条 TLS 直连，不再挤在 SSH 长连接里；直连不通时自动退回
        SSH。节点上会起 kin-slot-gate 监听该端口，请在节点防火墙只对控制面的出口
        IP 放行。
      </p>
      {link?.gate_error ? (
        <p className='text-xs text-destructive'>节点端：{link.gate_error}</p>
      ) : null}
      <div className='grid grid-cols-[1fr_7rem] gap-2'>
        <div className='space-y-1'>
          <Label htmlFor={`pl-addr-${node.id}`}>节点 IP</Label>
          <Input
            id={`pl-addr-${node.id}`}
            className='h-8 font-mono text-xs'
            placeholder='203.0.113.7'
            autoComplete='off'
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <div className='space-y-1'>
          <Label htmlFor={`pl-port-${node.id}`}>端口</Label>
          <Input
            id={`pl-port-${node.id}`}
            className='h-8 font-mono text-xs'
            placeholder={String(DEFAULT_PORT)}
            inputMode='numeric'
            autoComplete='off'
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
      </div>
      <div className='flex gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={busy || !address.trim()}
          onClick={() => save.mutate()}
        >
          {link ? '保存' : '启用'}
        </Button>
        {link ? (
          <Button
            size='sm'
            variant='ghost'
            disabled={busy}
            onClick={() => clear.mutate()}
          >
            关闭直连
          </Button>
        ) : null}
      </div>
    </section>
  )
}
