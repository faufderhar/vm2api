import { afterEach, describe, expect, it, vi } from 'vitest'
import { logoutRequest } from './api'
import {
  LS_BASE,
  LS_TOKEN,
  LS_USER,
  hasSession,
  setApiBase,
  setSession,
} from './session'

function installBrowser(hostname: string) {
  const values = new Map<string, string>()
  vi.stubGlobal('location', { hostname, protocol: 'https:' })
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  return values
}

afterEach(() => vi.unstubAllGlobals())

describe('panel session storage', () => {
  it('stores the username and drops a leftover bearer token', () => {
    const values = installBrowser('console.example')
    values.set(LS_TOKEN, 'old-token')

    setSession('admin')

    expect(values.get(LS_TOKEN)).toBeUndefined()
    expect(values.get(LS_USER)).toBe('admin')
    expect(hasSession()).toBe(true)
  })

  it('treats a stored username as signed in on an HTTP IP install', () => {
    const values = installBrowser('203.0.113.10')

    setSession('admin')

    expect(values.get(LS_TOKEN)).toBeUndefined()
    expect(hasSession()).toBe(true)
  })

  it('does not treat a leftover token alone as a session', () => {
    const values = installBrowser('203.0.113.10')
    values.set(LS_TOKEN, 'old-token')

    expect(hasSession()).toBe(false)
    expect(values.get(LS_TOKEN)).toBeUndefined()
  })

  it('keeps a separate API origin without storing a token', () => {
    const values = installBrowser('localhost')
    setApiBase('http://127.0.0.1:8787')

    setSession('admin')

    expect(values.get(LS_BASE)).toBe('http://127.0.0.1:8787')
    expect(values.get(LS_TOKEN)).toBeUndefined()
    expect(values.get(LS_USER)).toBe('admin')
  })

  it('calls the server logout endpoint without a readable bearer token', async () => {
    installBrowser('console.example')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    setSession('admin')

    logoutRequest()

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/panel/logout')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
    })
  })
})
