import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { indexVms } from '@/lib/vm-kind'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmsListQueryOptions } from '@/features/vm/queries'

/**
 * 槽位表，给日志 / 计费 / 代理页拼邮箱和平台徽标。管理员复用总览缓存；
 * 租户拿不到 dashboard（403），改读按归属过滤的 /api/panel/vms。
 */
export function useVmIndex() {
  const me = useQuery(meQueryOptions())
  const role = me.data?.role
  const fromDashboard = role === 'admin' || role === 'super'
  const dash = useQuery({ ...dashboardQueryOptions(), enabled: fromDashboard })
  const listed = useQuery({
    ...vmsListQueryOptions(),
    enabled: !!role && !fromDashboard,
  })
  const list: Vm[] = useMemo(
    () => (fromDashboard ? dash.data?.vms : listed.data?.items) || [],
    [fromDashboard, dash.data?.vms, listed.data?.items]
  )
  const vms = useMemo(() => indexVms(list), [list])
  const isLoading =
    me.isLoading || (fromDashboard ? dash.isLoading : listed.isLoading)
  return { vms, list, isLoading }
}
