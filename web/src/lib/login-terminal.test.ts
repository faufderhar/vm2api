import { describe, expect, it } from 'vitest'
import {
  captureLoginAuthUrl,
  loginAuthCode,
  loginAuthUrl,
} from './login-terminal'

const url = 'https://claude.com/cai/oauth/authorize?code=true&state=abc'

describe('login terminal shortcuts', () => {
  it('extracts the authorize URL from terminal text', () => {
    expect(loginAuthUrl(`Browser didn't open? ${url}\nPaste code`)).toBe(url)
    expect(loginAuthUrl('https://example.com/nope')).toBe('')
  })
  it('joins an authorize URL split across terminal frames', () => {
    const cut = url.indexOf('oauth')
    const first = captureLoginAuthUrl('', `open ${url.slice(0, cut)}`)
    expect(first.url).toBe('')
    const second = captureLoginAuthUrl(first.pending, url.slice(cut))
    expect(second.url).toBe(url)
  })

  it('accepts only a code and its state', () => {
    expect(loginAuthCode(' code#state ')).toBe('code#state')
    expect(loginAuthCode('code only')).toBe('')
  })
})
