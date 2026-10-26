import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { proxyNamedLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { dashboardQueryOptions } from '@/features/overview/queries'
import type { CommitResult } from '@/features/vm/credential-panel'
import {
  AccountFileField,
  Hint,
  type PickedFile,
  Seg,
} from '@/features/vm/credential-panel-parts'
import { vmQueryOptions } from '@/features/vm/queries'
import { useMmSsCountdown } from '@/features/vm/use-mmss-countdown'

type CodexImportMode = 'oauth' | 'access_token' | 'refresh_token' | 'json'

const MODES: { id: CodexImportMode; label: string }[] = [
  { id: 'oauth', label: 'OAuth' },
  { id: 'json', label: '账号文件' },
]

type Link = {
  sessionId: string
  authUrl: string
  expiresAt: number
  proxyHint: string
}

const EMPTY_LINK: Link = {
  sessionId: '',
  authUrl: '',
  expiresAt: 0,
  proxyHint: '',
}

export function CodexCredentialPanel({
  vm,
  onCommitted,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
}) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<CodexImportMode>('oauth')
  const [text, setText] = useState('')
  const [code, setCode] = useState('')
  const [link, setLink] = useState<Link>(EMPTY_LINK)
  const [fileError, setFileError] = useState('')
  const [pickedFile, setPickedFile] = useState<PickedFile | null>(null)

  const remaining = useMmSsCountdown(link.expiresAt)
  const linkReady = !!(link.sessionId && link.authUrl)
  const proxyHint =
    link.proxyHint || (vm.proxy?.host ? proxyNamedLabel(vm.proxy) : '')

  useEffect(() => {
    setText('')
    setCode('')
    setLink(EMPTY_LINK)
    setFileError('')
    setPickedFile(null)
  }, [vm.id, mode])

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
    ])

  const importCred = useMutation({
    mutationFn: () =>
      api<CommitResult>('/api/panel/vms/import', {
        method: 'POST',
        body: JSON.stringify({
          vm_id: vm.id,
          type: 'codex',
          mode,
          auth_json: text,
        }),
      }),
    onSuccess: async (data) => {
      setText('')
      setFileError('')
      setPickedFile(null)
      await invalidate()
      toast.success('已导入 GPT OAuth')
      onCommitted?.(data, vm.id, '已导入 GPT OAuth')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const gen = useMutation({
    mutationFn: () =>
      api<{
        auth_url?: string
        session_id?: string
        expires_at?: number
        proxy_hint?: string | null
      }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/generate-auth-url`,
        {
          method: 'POST',
          body: JSON.stringify({ flavor: 'codex' }),
        }
      ),
    onSuccess: (data) => {
      setLink({
        sessionId: String(data.session_id || ''),
        authUrl: String(data.auth_url || ''),
        expiresAt: Number(data.expires_at) || 0,
        proxyHint: String(data.proxy_hint || ''),
      })
      setCode('')
      toast.success('授权链接已生成')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const exchange = useMutation({
    mutationFn: () =>
      api<CommitResult>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/exchange-code`,
        {
          method: 'POST',
          body: JSON.stringify({
            session_id: link.sessionId,
            code: code.trim(),
            flavor: 'codex',
          }),
        }
      ),
    onSuccess: async (data) => {
      setCode('')
      setLink(EMPTY_LINK)
      await invalidate()
      toast.success('已完成 Codex OAuth')
      onCommitted?.(data, vm.id, '已完成 Codex OAuth')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const busy = importCred.isPending || gen.isPending || exchange.isPending
  const placeholder =
    '粘贴或上传 Codex CLI ~/.codex/auth.json、CPR 账号文件，或含 accessToken/refreshToken 的 JSON'

  return (
    <div className='space-y-3'>
      <Hint>
        对齐 Codex Desktop：OAuth 授权或账号文件（auth.json）。不要用 Claude
        sessionKey、Setup Token 或 Console Key。一槽一号。
      </Hint>
      <Seg
        label='账号添加方式'
        value={mode}
        options={MODES}
        onChange={setMode}
        disabled={busy}
      />
      {mode === 'oauth' ? (
        linkReady ? (
          <div className='space-y-2'>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                variant='outline'
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(link.authUrl)
                    .then(() => toast.success('已复制授权链接'))
                    .catch(() => toast.error('复制失败，请手动选中链接'))
                }}
              >
                <Copy className='size-3.5' aria-hidden='true' />
                复制链接
              </Button>
              <a
                className='inline-flex items-center gap-1 text-xs underline'
                href={link.authUrl}
                target='_blank'
                rel='noreferrer'
              >
                打开授权页
                <ExternalLink className='size-3' aria-hidden='true' />
              </a>
            </div>
            <p className='text-xs break-all text-muted-foreground'>
              {link.authUrl}
            </p>
            <p className='text-xs text-muted-foreground tabular-nums'>
              剩余有效 {remaining}
              {proxyHint ? ` · 经 ${proxyHint}` : ''}
            </p>
            <div className='space-y-1'>
              <Label htmlFor='codex-oauth-callback'>回调 URL</Label>
              <Textarea
                id='codex-oauth-callback'
                rows={3}
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
                placeholder='http://localhost:1455/auth/callback?code=...&state=...'
              />
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                disabled={!code.trim() || busy}
                loading={exchange.isPending}
                onClick={() => exchange.mutate()}
              >
                {exchange.isPending ? '验证中…' : '完成授权'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                loading={gen.isPending}
                onClick={() => gen.mutate()}
              >
                重新生成
              </Button>
            </div>
            <Hint>
              浏览器走 {proxyHint || '槽 SOCKS5'}。授权完成后把 localhost:1455
              回调整段贴回来。
            </Hint>
          </div>
        ) : (
          <div className='space-y-2'>
            <Hint>
              生成官方 Codex Desktop 授权链接。换票经槽
              SOCKS5，打开链接仍是本机浏览器。
            </Hint>
            <Button
              size='sm'
              disabled={busy}
              loading={gen.isPending}
              onClick={() => gen.mutate()}
            >
              {gen.isPending ? '生成中…' : '生成授权链接'}
            </Button>
          </div>
        )
      ) : (
        <div className='space-y-2'>
          <AccountFileField
            id='codex-import-text'
            label={
              mode === 'access_token'
                ? 'Access Token'
                : mode === 'refresh_token'
                  ? 'Refresh Token'
                  : '账号文件'
            }
            allowUpload={mode === 'json'}
            rows={8}
            placeholder={placeholder}
            busy={busy}
            text={text}
            setText={setText}
            pickedFile={pickedFile}
            setPickedFile={setPickedFile}
            fileError={fileError}
            setFileError={setFileError}
          />
          <Hint>
            支持 Codex CLI ~/.codex/auth.json、kernel accounts、CPR openai
            文档。仅 OPENAI_API_KEY 的客户端配置不能当 OAuth 导入。
          </Hint>
          <Button
            size='sm'
            disabled={!text.trim() || busy}
            loading={importCred.isPending}
            onClick={() => importCred.mutate()}
          >
            {importCred.isPending ? '写入中…' : '导入 GPT OAuth'}
          </Button>
        </div>
      )}
    </div>
  )
}
