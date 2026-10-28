import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { api, isApiError } from '@/lib/api'
import { captureLoginAuthUrl } from '@/lib/login-terminal'
import { apiBase } from '@/lib/session'
import {
  eraseEcho,
  SLASH_IDLE,
  type SlashLine,
  slashInput,
} from '@/lib/slash-line'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Phase = 'connecting' | 'open' | 'closed'

/** 面板侧快捷指令：不进 shell，结果逐行写进终端。 */
export type SlashCommand = {
  name: string
  desc: string
  run: () => Promise<string[]>
}

const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** 调用方指令 + 内置 `/help` `/clear`；没有调用方指令时不启用快捷指令。 */
function withBuiltins(own: SlashCommand[]): SlashCommand[] {
  if (!own.length) return []
  const list: SlashCommand[] = [
    ...own,
    {
      name: '/help',
      desc: '列出快捷指令',
      run: async () =>
        list.map((c) => `  ${c.name.padEnd(10)}${DIM}${c.desc}${RESET}`),
    },
    { name: '/clear', desc: '清屏', run: async () => [] },
  ]
  return list
}

/**
 * xterm ↔ WebSocket ↔ 远端 TTY（集群节点 SSH shell / 槽容器 exec）。浏览器
 * 不能在 WebSocket 握手上带 Authorization，所以每次连接先用面板会话换一张
 * 30s 一次性 ticket。传入 `commands` 时启用 `/` 快捷指令与按钮栏。
 */
export type LoginTerminalHandle = {
  paste: (text: string) => void
}

export const WsTerminal = forwardRef<
  LoginTerminalHandle,
  {
    ticketPath: string
    socketPath: string
    commands?: SlashCommand[]
    startupCommand?: string
    officialLogin?: boolean
    onLogin?: () => void
    onAuthUrl?: (url: string) => void
  }
>(function WsTerminal(
  {
    ticketPath,
    socketPath,
    commands,
    startupCommand,
    officialLogin,
    onLogin,
    onAuthUrl,
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const sendRef = useRef<(data: string) => void>(() => {})
  const lineRef = useRef<SlashLine>(SLASH_IDLE)
  const busyRef = useRef(false)
  const commandsRef = useRef<SlashCommand[]>([])
  const [phase, setPhase] = useState<Phase>('connecting')
  const [note, setNote] = useState('')
  const [session, setSession] = useState(0)
  const [running, setRunning] = useState('')
  const [ticket, setTicket] = useState('')
  const [asking, setAsking] = useState(false)
  const [password, setPassword] = useState('')
  const [sentPassword, setSentPassword] = useState('')
  const [stepUpNote, setStepUpNote] = useState('')

  useEffect(() => {
    let cancelled = false
    setTicket('')
    setAsking(false)
    setPhase('connecting')
    setNote('')
    const body: { login?: boolean; password?: string } = {}
    if (officialLogin) body.login = true
    if (sentPassword) body.password = sentPassword
    api<{ ticket: string }>(ticketPath, {
      method: 'POST',
      body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    })
      .then(({ ticket: issued }) => {
        if (cancelled) return
        setTicket(issued)
        setAsking(false)
        setStepUpNote('')
      })
      .catch((err: Error) => {
        if (cancelled) return
        if (
          isApiError(err) &&
          (err.code === 'step_up_required' || err.code === 'step_up_failed')
        ) {
          setAsking(true)
          setStepUpNote(err.code === 'step_up_failed' ? err.message : '')
          setPhase('connecting')
          return
        }
        setNote(err.message)
        setPhase('closed')
      })
    return () => {
      cancelled = true
    }
  }, [ticketPath, session, officialLogin, sentPassword])

  useEffect(() => {
    commandsRef.current = commands || []
  }, [commands])

  /**
   * `echoed` = 终端里已本地回显的指令字符数（键入触发）；按钮触发为 0，
   * 由这里补写指令名，看起来同手敲一致。
   */
  const execute = useCallback(async (name: string, echoed: number) => {
    const term = termRef.current
    const cmd = withBuiltins(commandsRef.current).find((c) => c.name === name)
    if (!term || !cmd || busyRef.current) return
    if (term.buffer.active.type !== 'normal') {
      setNote('全屏程序运行中，退出后再执行快捷指令')
      return
    }
    const line = lineRef.current
    // 按钮触发时 shell 行里若已有半截输入，执行完不能替它按回车。
    const shellLineEmpty = echoed > 0 || line.clean || line.buf !== null
    if (!echoed && line.buf !== null) term.write(eraseEcho(line.buf.length))
    lineRef.current = shellLineEmpty ? SLASH_IDLE : line
    if (name === '/clear') {
      if (echoed) term.write(eraseEcho(echoed))
      term.clear()
      return
    }
    if (echoed) term.write('\r\n')
    else if (shellLineEmpty) term.write(`${DIM}${name}${RESET}\r\n`)
    else term.write(`\r\n${DIM}${name}${RESET}\r\n`)
    busyRef.current = true
    setRunning(name)
    let rows: string[]
    try {
      rows = await cmd.run()
    } catch (err) {
      rows = [`${RED}✗ ${(err as Error).message}${RESET}`]
    } finally {
      busyRef.current = false
      setRunning('')
    }
    // 指令跑的时候终端可能已被关掉或重开。
    if (termRef.current !== term) return
    for (const row of rows) term.write(`${row}\r\n`)
    // 空行回车只让 shell 重画提示符。
    if (shellLineEmpty) sendRef.current('\r')
  }, [])

  const onLoginRef = useRef(onLogin)
  onLoginRef.current = onLogin
  const onAuthUrlRef = useRef(onAuthUrl)
  onAuthUrlRef.current = onAuthUrl
  const seenUrl = useRef('')
  const urlTail = useRef('')
  const captureUrl = (raw: string) => {
    const found = captureLoginAuthUrl(urlTail.current, raw)
    urlTail.current = found.pending
    if (!found.url || found.url === seenUrl.current) return
    seenUrl.current = found.url
    onAuthUrlRef.current?.(found.url)
  }
  useEffect(() => {
    const host = hostRef.current
    if (!host || !ticket) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      scrollback: 5000,
      theme: { background: '#0b0d10' },
      windowOptions: { getWinSizeChars: true, getCellSizePixels: true },
    })
    term.parser.registerOscHandler(52, (data) => {
      const payload = data.split(';').pop() || ''
      if (!payload || payload === '?') return true
      try {
        const text = atob(payload)
        captureUrl(text)
        void navigator.clipboard?.writeText(text).catch(() => {})
      } catch {
        /* CLI copy is best-effort; the URL stays selectable. */
      }
      return true
    })
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type !== 'keydown' ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== 'v'
      ) {
        return true
      }
      const selected = term.getSelection()
      if (!selected) return false
      event.preventDefault()
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text && termRef.current === term) term.paste(text)
        })
        .catch(() => {})
      return false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    lineRef.current = SLASH_IDLE
    setPhase('connecting')
    setNote('')

    let ws: WebSocket | null = null
    let disposed = false
    const send = (msg: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    sendRef.current = (d) => send({ t: 'd', d })
    const onData = term.onData((d) => {
      // 指令执行中丢弃键入：否则 shell 回显会和输出交错，结束时的回车还会把它执行掉。
      if (busyRef.current) return
      const step = slashInput(
        lineRef.current,
        d,
        withBuiltins(commandsRef.current).map((c) => c.name),
        term.buffer.active.type === 'normal'
      )
      lineRef.current = step.line
      for (const a of step.actions) {
        if (a.kind === 'echo') term.write(a.data)
        else if (a.kind === 'shell') send({ t: 'd', d: a.data })
        else void execute(a.name, a.echoed)
      }
    })
    const onResize = term.onResize(({ cols, rows }) =>
      send({ t: 'r', c: cols, r: rows })
    )
    const observer = new ResizeObserver(() => fit.fit())
    const base = new URL(apiBase() || window.location.origin)
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    base.pathname = socketPath
    base.search = new URLSearchParams({
      cols: String(term.cols),
      rows: String(term.rows),
      ...(officialLogin ? { login: '1' } : {}),
    }).toString()
    ws = new WebSocket(base.toString(), [`vm2api-ticket.${ticket}`])
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      setPhase('open')
      term.focus()
      if (startupCommand && !officialLogin)
        send({ t: 'd', d: `${startupCommand}\r` })
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const bytes = new Uint8Array(e.data as ArrayBuffer)
        term.write(bytes)
        captureUrl(new TextDecoder().decode(bytes))
        return
      }
      const msg = JSON.parse(e.data) as {
        t: string
        code?: number | null
        message?: string
      }
      if (msg.t === 'exit') setNote(`会话退出（code ${msg.code ?? '—'}）`)
      if (msg.t === 'login') onLoginRef.current?.()
      if (msg.t === 'error') setNote(msg.message || '终端错误')
    }
    ws.onclose = () => {
      if (!disposed) setPhase('closed')
    }

    return () => {
      disposed = true
      observer.disconnect()
      onData.dispose()
      onResize.dispose()
      ws?.close()
      sendRef.current = () => {}
      termRef.current = null
      term.dispose()
    }
  }, [ticket, socketPath, execute, startupCommand, officialLogin])

  useImperativeHandle(
    ref,
    () => ({
      paste(text) {
        const value = String(text || '')
        if (!value || !termRef.current) return
        termRef.current.paste(value.endsWith('\n') ? value : `${value}\n`)
        termRef.current.focus()
      },
    }),
    []
  )
  return (
    <div className='flex h-full min-h-0 flex-col gap-2'>
      <div className='flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground'>
        <span>
          {phase === 'connecting'
            ? '连接中…'
            : phase === 'open'
              ? `已连接${note ? ` · ${note}` : ''}`
              : `已断开${note ? ` · ${note}` : ''}`}
        </span>
        <div className='flex flex-wrap items-center gap-1.5'>
          {commands?.map((c) => (
            <Button
              key={c.name}
              size='sm'
              variant='outline'
              className='h-7 font-mono text-xs'
              title={c.desc}
              disabled={phase !== 'open' || !!running}
              onClick={() => {
                void execute(c.name, 0)
                termRef.current?.focus()
              }}
            >
              {running === c.name ? `${c.name}…` : c.name}
            </Button>
          ))}
          {phase === 'closed' ? (
            <Button
              size='sm'
              variant='outline'
              className='h-7'
              onClick={() => setSession((n) => n + 1)}
            >
              重新打开
            </Button>
          ) : null}
        </div>
      </div>
      {asking ? (
        <form
          className='flex flex-wrap items-center gap-2'
          onSubmit={(event) => {
            event.preventDefault()
            setSentPassword(password)
          }}
        >
          <Input
            type='password'
            autoComplete='current-password'
            autoFocus
            placeholder='当前登录密码'
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className='h-8 max-w-56'
          />
          <Button type='submit' size='sm' className='h-8' disabled={!password}>
            确认
          </Button>
          <span className='text-xs text-muted-foreground'>
            {stepUpNote || '打开终端需要当前密码，通过后 5 分钟内不用再输。'}
          </span>
        </form>
      ) : null}
      <div
        ref={hostRef}
        className={
          asking
            ? 'hidden'
            : 'min-h-0 flex-1 overflow-hidden rounded-md border bg-[#0b0d10] p-1'
        }
      />
    </div>
  )
})
