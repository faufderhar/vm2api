import { type FormEvent, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { setStepUpPrompt } from '@/lib/step-up'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PasswordInput } from '@/components/password-input'

/** One dialog for every route that answers `step_up_required`; see panelFetchWithStepUp. */
export function StepUpDialog() {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const settle = useRef<((confirmed: boolean) => void) | null>(null)

  useEffect(() => {
    setStepUpPrompt(
      () =>
        new Promise<boolean>((resolve) => {
          settle.current = resolve
          setPassword('')
          setError('')
          setOpen(true)
        })
    )
    return () => {
      setStepUpPrompt(null)
      settle.current?.(false)
      settle.current = null
    }
  }, [])

  function finish(confirmed: boolean) {
    setOpen(false)
    setPassword('')
    setError('')
    settle.current?.(confirmed)
    settle.current = null
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/api/panel/step-up', {
        method: 'POST',
        body: JSON.stringify({ password }),
        stepUp: false,
      })
      finish(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) finish(false)
      }}
    >
      <DialogContent className='sm:max-w-sm'>
        <form className='space-y-4' onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>确认当前密码</DialogTitle>
            <DialogDescription>
              这是敏感操作，需要再次输入当前登录密码，通过后 5 分钟内不用再输。
            </DialogDescription>
          </DialogHeader>
          <PasswordInput
            autoComplete='current-password'
            autoFocus
            placeholder='当前登录密码'
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? <p className='text-sm text-destructive'>{error}</p> : null}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={busy}
              onClick={() => finish(false)}
            >
              取消
            </Button>
            <Button type='submit' disabled={!password || busy}>
              确认
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
