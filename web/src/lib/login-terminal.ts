const AUTH_URL = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\u0007]+/

/** The manual authorize URL Claude prints or copies. */
export function loginAuthUrl(raw = ''): string {
  const match = String(raw || '').match(AUTH_URL)
  return match ? match[0].replace(/[)\]}>.,]+$/, '') : ''
}

/** Claude accepts `code#state`. A bare code is not enough. */
export function loginAuthCode(raw = ''): string {
  const text = String(raw || '').trim()
  const [code, state] = text.split('#')
  if (!code || !state || /\s/.test(text)) return ''
  return text
}
const URL_TAIL = 4096

/** Keep a short tail so an authorize URL split across terminal frames still matches. */
export function captureLoginAuthUrl(
  previous = '',
  chunk = ''
): {
  url: string
  pending: string
} {
  const pending = `${previous}${chunk}`.slice(-URL_TAIL)
  return { url: loginAuthUrl(pending), pending }
}
