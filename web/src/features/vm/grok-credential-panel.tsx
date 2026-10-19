import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Copy, ExternalLink, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { proxyNamedLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { dashboardQueryOptions } from '@/features/overview/queries'
import type { CommitResult } from '@/features/vm/credential-panel'
import { vmQueryOptions } from '@/features/vm/queries'

type GrokImportMode = 'oauth' | 'json' | 'refresh_token' | 'access_token'

const MODES: { id: GrokImportMode; label: string }[] = [
  { id: 'oauth', label: 'OAuth' },
  { id: 'json', label: '账号文件' },
  { id: 'refresh_token', label: 'Refresh Token' },
  { id: 'access_token', label: 'Access Token' },
]

type AuthLink = {
  sessionId: string
  authUrl: string
  userCode: string
  expiresAt: number
  intervalSec: number
  proxyHint: string
}

const EMPTY_LINK: AuthLink = {
  sessionId: '',
  authUrl: '',
  userCode: '',
  expiresAt: 0,
  intervalSec: 5,
  proxyHint: '',
}

function Seg({
  value,
  onChange,
  disabled,
}: {
  value: GrokImportMode
  onChange: (next: GrokImportMode) => void
  disabled?: boolean
}) {
  return (
    <div
      role='tablist'
      aria-label='账号添加方式'
      className='flex flex-wrap items-center gap-1.5'
    >
      {MODES.map((option) => (
        <Button
          key={option.id}
          type='button'
          role='tab'
          size='sm'
          aria-selected={value === option.id}
          disabled={disabled}
          variant={value === option.id ? 'default' : 'outline'}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className='text-xs text-muted-foreground'>{children}</p>
}

function fileSizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
}

function useCountdown(expiresAt: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000))
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function GrokCredentialPanel({
  vm,
  onCommitted,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<GrokImportMode>('oauth')
  const [text, setText] = useState('')
  const [link, setLink] = useState<AuthLink>(EMPTY_LINK)
  const [fileError, setFileError] = useState('')
  const [pickedFile, setPickedFile] = useState<{
    name: string
    size: number
  } | null>(null)
  const pollInterval = useRef(5)
  const committedRef = useRef(onCommitted)
  committedRef.current = onCommitted

  const remaining = useCountdown(link.expiresAt)
  const linkReady = !!(link.sessionId && link.userCode)
  const proxyHint =
    link.proxyHint || (vm.proxy?.host ? proxyNamedLabel(vm.proxy) : '')

  useEffect(() => {
    setText('')
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
          type: 'grok',
          mode,
          auth_json: text,
        }),
      }),
    onSuccess: async (data) => {
      setText('')
      setFileError('')
      setPickedFile(null)
      await invalidate()
      toast.success('已导入 Grok 账号')
      onCommitted?.(data, vm.id, '已导入 Grok 账号')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const gen = useMutation({
    mutationFn: () =>
      api<{
        auth_url?: string
        user_code?: string
        session_id?: string
        expires_at?: number
        interval_sec?: number
        proxy_hint?: string | null
      }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/generate-auth-url`,
        {
          method: 'POST',
          body: JSON.stringify({ flavor: 'grok' }),
        }
      ),
    onSuccess: (data) => {
      pollInterval.current = Number(data.interval_sec) || 5
      setLink({
        sessionId: String(data.session_id || ''),
        authUrl: String(data.auth_url || ''),
        userCode: String(data.user_code || ''),
        expiresAt: Number(data.expires_at) || 0,
        intervalSec: Number(data.interval_sec) || 5,
        proxyHint: String(data.proxy_hint || ''),
      })
      toast.success('请在 xAI 页面输入验证码')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  useEffect(() => {
    if (mode !== 'oauth' || !link.sessionId) return
    let stopped = false
    let timer = 0
    const sessionId = link.sessionId
    const schedule = (seconds: number) => {
      timer = window.setTimeout(() => {
        void pollOnce()
      }, Math.max(1, seconds) * 1000)
    }
    async function pollOnce() {
      if (stopped) return
      try {
        const data = await api<{ status?: string; interval_sec?: number } & CommitResult>(
          `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/device-poll`,
          {
            method: 'POST',
            body: JSON.stringify({ session_id: sessionId, flavor: 'grok' }),
          }
        )
        if (stopped) return
        if (data.status === 'authorized') {
          setLink(EMPTY_LINK)
          await Promise.all([
            qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
            qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
          ])
          toast.success('已完成 xAI 授权')
          committedRef.current?.(data, vm.id, '已完成 xAI 授权')
          return
        }
        const next = Number(data.interval_sec) || pollInterval.current || 5
        pollInterval.current = next
        schedule(next)
      } catch (error) {
        if (stopped) return
        setLink(EMPTY_LINK)
        toast.error(error instanceof Error ? error.message : '授权失败')
      }
    }
    schedule(pollInterval.current || 5)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [mode, link.sessionId, qc, vm.id])

  const busy = importCred.isPending || gen.isPending
  const textLabel =
    mode === 'access_token'
      ? 'Access Token'
      : mode === 'refresh_token'
        ? 'Refresh Token'
        : '账号文件'
  const placeholder =
    mode === 'access_token'
      ? '粘贴 xAI access_token'
      : mode === 'refresh_token'
        ? '粘贴 xAI refresh_token，导入时会立即换一次 access_token'
        : '粘贴或上传含 access_token / refresh_token 的 JSON 账号文件'

  async function onPickFile(file: File | undefined) {
    setFileError('')
    if (!file) return
    try {
      const raw = await file.text()
      setText(raw)
      setPickedFile({ name: file.name, size: file.size })
    } catch {
      setPickedFile(null)
      setFileError('文件读取失败')
    }
  }

  return (
    <div className='space-y-3'>
      <Hint>
        xAI OAuth 授权或账号文件。不要用 Claude sessionKey、Codex auth.json 或
        xAI API Key。一槽一号，换票与推理都经槽代理。
      </Hint>
      <Seg value={mode} onChange={setMode} disabled={busy} />
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
            <div className='rounded-md border px-3 py-2'>
              <p className='text-xs text-muted-foreground'>验证码</p>
              <p className='font-mono text-lg tracking-[0.2em]'>{link.userCode}</p>
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                variant='outline'
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(link.userCode)
                    .then(() => toast.success('已复制验证码'))
                    .catch(() => toast.error('复制失败'))
                }}
              >
                <Copy className='size-3.5' aria-hidden='true' />
                复制验证码
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                loading={gen.isPending}
                onClick={() => gen.mutate()}
              >
                重新开始
              </Button>
            </div>
            <Hint>打开授权页，输入上面的验证码。确认后这里会自动完成，不用粘贴回调。</Hint>
          </div>
        ) : (
          <div className='space-y-2'>
            <Hint>
              使用 xAI 官方客户端发起设备码登录。不用填写授权地址、client id 或回调地址。
            </Hint>
            <Button
              size='sm'
              disabled={busy}
              loading={gen.isPending}
              onClick={() => gen.mutate()}
            >
              {gen.isPending ? '请求中…' : '开始授权'}
            </Button>
          </div>
        )
      ) : (
        <div className='space-y-2'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <Label htmlFor='grok-import-text'>{textLabel}</Label>
            {mode === 'json' ? (
              <>
                <input
                  ref={fileRef}
                  type='file'
                  accept='application/json,.json'
                  className='hidden'
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    void onPickFile(file)
                  }}
                />
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className='size-3.5' aria-hidden='true' />
                  上传文件
                </Button>
              </>
            ) : null}
          </div>
          {pickedFile ? (
            <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2'>
              <div className='min-w-0'>
                <p className='truncate text-sm'>{pickedFile.name}</p>
                <p className='text-xs text-muted-foreground'>
                  {fileSizeLabel(pickedFile.size)} · 已读取，不展示原文
                </p>
              </div>
              <Button
                type='button'
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={() => {
                  setPickedFile(null)
                  setText('')
                  setFileError('')
                }}
              >
                清除
              </Button>
            </div>
          ) : (
            <Textarea
              id='grok-import-text'
              rows={mode === 'json' ? 8 : 4}
              value={text}
              disabled={busy}
              onChange={(event) => {
                setFileError('')
                setText(event.target.value)
              }}
              placeholder={placeholder}
            />
          )}
          {fileError ? (
            <p className='text-xs text-destructive'>{fileError}</p>
          ) : null}
          {mode === 'access_token' ? (
            <Hint>只有 access_token 时无法自动续期，过期后需要重新导入。</Hint>
          ) : null}
          <Button
            size='sm'
            disabled={!text.trim() || busy}
            loading={importCred.isPending}
            onClick={() => importCred.mutate()}
          >
            {importCred.isPending ? '写入中…' : '导入 Grok 账号'}
          </Button>
        </div>
      )}
    </div>
  )
}
