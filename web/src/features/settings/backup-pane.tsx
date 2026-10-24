import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, api, panelFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  backupConfigQueryOptions,
  backupsQueryOptions,
} from '@/features/settings/queries'
import { RawConfigFields } from '@/features/settings/raw-config-fields'

export function BackupPane() {
  const qc = useQueryClient()
  const list = useQuery(backupsQueryOptions())
  const cfg = useQuery(backupConfigQueryOptions())
  const [restoreId, setRestoreId] = useState('')
  const [restorePassword, setRestorePassword] = useState('')
  const create = useMutation({
    mutationFn: () => api('/api/panel/backups', { method: 'POST', body: '{}' }),
    onSuccess: async () => {
      toast.success('已创建备份')
      await qc.invalidateQueries({ queryKey: backupsQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const items = list.data?.items || []

  async function download(id: string) {
    const res = await panelFetch(
      `/api/panel/backups/${encodeURIComponent(id)}/download`
    )
    if (!res.ok) throw new ApiError('下载失败', res.status)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `backup-${id}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle>备份</CardTitle>
        <Button
          size='sm'
          onClick={() => create.mutate()}
          disabled={create.isPending}
          loading={create.isPending}
        >
          创建
        </Button>
      </CardHeader>
      <CardContent className='space-y-4'>
        <p className='text-sm text-muted-foreground'>
          恢复须 confirm: true。恢复期间协议口 503。
        </p>
        <RawConfigFields
          value={cfg.data as Record<string, unknown> | undefined}
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>时间</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((b) => (
              <TableRow key={b.id}>
                <TableCell className='font-mono text-xs'>{b.id}</TableCell>
                <TableCell>{b.created_at || '—'}</TableCell>
                <TableCell className='space-x-1'>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() =>
                      download(b.id).catch((e: Error) => toast.error(e.message))
                    }
                  >
                    下载
                  </Button>
                  <Button
                    size='sm'
                    variant='destructive'
                    onClick={() => setRestoreId(b.id)}
                  >
                    恢复
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ConfirmDialog
          open={!!restoreId}
          onOpenChange={() => {
            setRestoreId('')
            setRestorePassword('')
          }}
          title='确认恢复备份'
          desc='恢复会覆盖当前状态，期间协议口返回 503。必须显式确认。'
          confirmText='确认恢复'
          cancelBtnText='取消'
          destructive
          disabled={!restorePassword}
          handleConfirm={() => {
            api(`/api/panel/backups/${encodeURIComponent(restoreId)}/restore`, {
              method: 'POST',
              body: JSON.stringify({
                confirm: true,
                password: restorePassword,
              }),
            })
              .then(async () => {
                toast.success('已开始恢复')
                setRestoreId('')
                setRestorePassword('')
                await qc.invalidateQueries({ queryKey: ['panel'] })
              })
              .catch((e: Error) => toast.error(e.message))
          }}
        >
          <Input
            type='password'
            autoComplete='current-password'
            placeholder='当前登录密码'
            value={restorePassword}
            onChange={(event) => setRestorePassword(event.target.value)}
          />
        </ConfirmDialog>
      </CardContent>
    </Card>
  )
}
