import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, normalizePanelError, panelFetch } from './api'
import {
  hasSession,
  onPanelSessionExpired,
  sessionToken,
  setSession,
} from './session'
import { setStepUpPrompt } from './step-up'

function installBrowser() {
  const values = new Map<string, string>()
  vi.stubGlobal('location', { hostname: 'console.example', protocol: 'https:' })
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  })
  return values
}

describe('panel error envelope', () => {
  it('preserves structured error metadata', () => {
    const normalized = normalizePanelError(
      {
        error: {
          type: 'permission_error',
          code: 'forbidden',
          message: '没有权限',
          details: { capability: 'users' },
        },
        data: { refresh_class: 'fatal' },
      },
      403,
      'Forbidden'
    )

    expect(normalized).toEqual({
      message: '没有权限',
      status: 403,
      type: 'permission_error',
      code: 'forbidden',
      details: { capability: 'users' },
      data: { refresh_class: 'fatal' },
    })
  })

  it('keeps string error codes compatible with existing callers', () => {
    const error = new ApiError('冲突', 409, 'conflict')
    expect(error).toMatchObject({ status: 409, code: 'conflict' })
  })
})

describe('panelFetch 401', () => {
  beforeEach(() => {
    installBrowser()
    setSession('admin')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears session and notifies on panel API 401', async () => {
    const expired = vi.fn()
    onPanelSessionExpired(expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    )
    const res = await panelFetch('/api/panel/me')
    expect(res.status).toBe(401)
    expect(hasSession()).toBe(false)
    expect(sessionToken()).toBe('')
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('does not put a bearer token on panel requests', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const res = await panelFetch('/api/panel/me')
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include',
    })
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'Authorization'
    )
  })

  it('does not expire session when panel login returns 401', async () => {
    const expired = vi.fn()
    onPanelSessionExpired(expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    )
    const res = await panelFetch('/api/panel/login', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(hasSession()).toBe(true)
    expect(expired).not.toHaveBeenCalled()
  })
})

describe('step-up refusal', () => {
  const refusal = (code: string) =>
    new Response(
      JSON.stringify({ ok: false, error: { code, message: '要密码' } }),
      {
        status: 401,
      }
    )

  beforeEach(() => {
    installBrowser()
    setSession('admin')
  })

  afterEach(() => {
    setStepUpPrompt(null)
    vi.unstubAllGlobals()
  })

  it('keeps the session on a step-up 401', async () => {
    const expired = vi.fn()
    onPanelSessionExpired(expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal('step_up_failed'))
    )
    const res = await panelFetch('/api/panel/backups/b1/restore', {
      method: 'POST',
    })
    expect(res.status).toBe(401)
    expect(hasSession()).toBe(true)
    expect(expired).not.toHaveBeenCalled()
  })

  it('retries the request once the password is confirmed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(refusal('step_up_required'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, data: { done: 1 } }))
      )
    vi.stubGlobal('fetch', fetchMock)
    const ask = vi.fn(async () => true)
    setStepUpPrompt(ask)
    await expect(
      api('/api/panel/users', { method: 'POST', body: '{}' })
    ).resolves.toEqual({ done: 1 })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces the refusal when the prompt is cancelled', async () => {
    const fetchMock = vi.fn(async () => refusal('step_up_required'))
    vi.stubGlobal('fetch', fetchMock)
    setStepUpPrompt(async () => false)
    await expect(api('/api/panel/users')).rejects.toMatchObject({
      code: 'step_up_required',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves the prompt to callers that opt out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal('step_up_required'))
    )
    const ask = vi.fn(async () => true)
    setStepUpPrompt(ask)
    await expect(api('/api/panel/x', { stepUp: false })).rejects.toMatchObject({
      code: 'step_up_required',
    })
    expect(ask).not.toHaveBeenCalled()
  })
})
