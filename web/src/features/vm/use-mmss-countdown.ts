import { useEffect, useState } from 'react'

/** 授权链接倒计时，固定 mm:ss（Codex / Grok 面板）。 */
export function useMmSsCountdown(expiresAt: number) {
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
