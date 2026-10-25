import { describe, expect, it } from 'vitest'
import {
  fmtInterval,
  GROK_CLIENTS,
  GROK_DEFAULT_BASE_URL,
  GROK_PROTOCOLS,
  grokIssues,
  grokView,
  isGrokBaseUrl,
  isGrokOauthEndpoint,
  routingHasGrok,
  setClient,
  setProtocolMode,
  setSub,
} from './grok-settings-model'

describe('grokView', () => {
  it('falls back to the backend defaults on an empty block', () => {
    const v = grokView({})
    expect(v).toMatchObject({
      enabled: false,
      baseUrl: GROK_DEFAULT_BASE_URL,
      tokenUrl: '',
      refreshSkewSec: 300,
      maxConcurrency: 2,
      maxRpm: 0,
      maxSessions: 0,
      billingBackground: true,
      billingIntervalMin: 30,
    })
    expect(v.protocols).toEqual({
      'openai.responses': 'native',
      'openai.chat': 'native',
      'openai.completions': 'reject',
      'anthropic.messages': 'reject',
    })
    expect(v.clients).toEqual({
      official_codex: 'allow',
      openai_compatible: 'allow',
      claude_code: 'reject',
      unknown: 'allow',
    })
  })

  it('reads the saved routing block', () => {
    const v = grokView({
      enabled: true,
      base_url: 'https://api.x.ai',
      oauth: { refresh_skew_sec: 600, token_url: 'https://auth.x.ai/t' },
      protocols: { 'anthropic.messages': { mode: 'convert', enabled: true } },
      clients: { claude_code: 'allow', unknown: 'reject' },
      quota: { max_concurrency: 4, max_rpm: 60, max_sessions: 3 },
      billing: { background: false, min_interval_sec: 7200 },
    })
    expect(v.enabled).toBe(true)
    expect(v.baseUrl).toBe('https://api.x.ai')
    expect(v.refreshSkewSec).toBe(600)
    expect(v.protocols['anthropic.messages']).toBe('convert')
    expect(v.clients.claude_code).toBe('allow')
    expect(v.clients.unknown).toBe('reject')
    expect([v.maxConcurrency, v.maxRpm, v.maxSessions]).toEqual([4, 60, 3])
    expect(v.billingBackground).toBe(false)
    expect(v.billingIntervalMin).toBe(120)
  })

  it('treats an unknown protocol mode as reject, like the backend', () => {
    const v = grokView({ protocols: { 'openai.chat': { mode: 'convert' } } })
    expect(v.protocols['openai.chat']).toBe('reject')
  })

  it('covers every protocol and client the gateway knows', () => {
    expect(GROK_PROTOCOLS.map((p) => p.key).sort()).toEqual([
      'anthropic.messages',
      'openai.chat',
      'openai.completions',
      'openai.responses',
    ])
    expect(GROK_CLIENTS).toHaveLength(4)
  })
})

describe('URL rules mirror grok-route.mjs', () => {
  it('accepts only https grok.com / x.ai hosts for the upstream', () => {
    expect(isGrokBaseUrl('https://cli-chat-proxy.grok.com')).toBe(true)
    expect(isGrokBaseUrl('https://api.x.ai/')).toBe(true)
    expect(isGrokBaseUrl('http://cli-chat-proxy.grok.com')).toBe(false)
    expect(isGrokBaseUrl('https://evil.example.com')).toBe(false)
    expect(isGrokBaseUrl('https://notgrok.com')).toBe(false)
    expect(isGrokBaseUrl('https://u:p@api.x.ai')).toBe(false)
    expect(isGrokBaseUrl('')).toBe(false)
  })

  it('accepts x.ai https or loopback for OAuth endpoints', () => {
    expect(isGrokOauthEndpoint('https://auth.x.ai/oauth2/token')).toBe(true)
    expect(isGrokOauthEndpoint('http://127.0.0.1:9000/token')).toBe(true)
    expect(isGrokOauthEndpoint('http://auth.x.ai/token')).toBe(false)
    expect(isGrokOauthEndpoint('https://grok.com/token')).toBe(false)
  })
})

describe('grokIssues', () => {
  it('is empty for defaults and valid values', () => {
    expect(grokIssues(undefined)).toEqual([])
    expect(grokIssues({})).toEqual([])
    expect(
      grokIssues({ base_url: 'https://api.x.ai', oauth: { token_url: '' } })
    ).toEqual([])
  })

  it('flags a bad or empty upstream and a bad token_url', () => {
    expect(grokIssues({ base_url: 'https://example.com' })[0]).toMatchObject({
      field: 'base_url',
    })
    expect(grokIssues({ base_url: '  ' })[0].message).toContain('不能为空')
    expect(
      grokIssues({ oauth: { token_url: 'https://example.com/t' } })[0]
    ).toMatchObject({ field: 'token_url' })
  })
})

describe('patch builders', () => {
  const base = {
    enabled: true,
    protocols: { 'openai.chat': { mode: 'native', enabled: true } },
  }

  it('setProtocolMode keeps enabled in step with the mode', () => {
    const next = setProtocolMode(base, 'anthropic.messages', 'convert')
    expect(next.protocols).toEqual({
      'openai.chat': { mode: 'native', enabled: true },
      'anthropic.messages': { mode: 'convert', enabled: true },
    })
    const off = setProtocolMode(next, 'openai.chat', 'reject')
    expect((off.protocols as Record<string, unknown>)['openai.chat']).toEqual({
      mode: 'reject',
      enabled: false,
    })
    expect(base.protocols['openai.chat'].mode).toBe('native')
  })

  it('setClient writes allow / reject only for that client', () => {
    const next = setClient(
      { clients: { unknown: 'allow' } },
      'claude_code',
      true
    )
    expect(next.clients).toEqual({ unknown: 'allow', claude_code: 'allow' })
  })

  it('setSub merges into the nested section and keeps hidden backend fields', () => {
    const grok = {
      oauth: { refresh_skew_sec: 300, redirect_uri: 'https://keep.me/cb' },
      websocket: { enabled: false },
    }
    const next = setSub(grok, 'oauth', { refresh_skew_sec: 900 })
    expect(next.oauth).toEqual({
      refresh_skew_sec: 900,
      redirect_uri: 'https://keep.me/cb',
    })
    expect(next.websocket).toEqual({ enabled: false })
    expect(setSub({}, 'billing', { min_interval_sec: 3600 }).billing).toEqual({
      min_interval_sec: 3600,
    })
  })
})

describe('fmtInterval', () => {
  it('reads as minutes or hours', () => {
    expect(fmtInterval(30)).toBe('30 分钟')
    expect(fmtInterval(60)).toBe('1 小时')
    expect(fmtInterval(90)).toBe('1 小时 30 分钟')
    expect(fmtInterval(1440)).toBe('24 小时')
  })
})

// 回归：设置 › Grok 保存后刷新总是显示默认值。后端 GET 现在回传规范化后的 grok 段，
// 前端用它水合草稿、整份 PUT 回去。这里模拟「GET → 改 → PUT 体 → 再 GET → 显示」。
describe('save / reload round-trip', () => {
  // 与后端 normalizeGrokRouting 的输出同形（GET /api/panel/routing 的 data.grok）。
  const serverGrok = {
    enabled: false,
    base_url: GROK_DEFAULT_BASE_URL,
    oauth: {
      authorize_url: '',
      token_url: '',
      client_id: '',
      redirect_uri: '',
      scope: '',
      extra_authorize_params: {},
      refresh_skew_sec: 300,
    },
    websocket: { enabled: false },
    protocols: {
      'openai.responses': { mode: 'native', enabled: true },
      'openai.chat': { mode: 'native', enabled: true },
      'openai.completions': { mode: 'reject', enabled: false },
      'anthropic.messages': { mode: 'reject', enabled: false },
    },
    clients: {
      official_codex: 'allow',
      openai_compatible: 'allow',
      claude_code: 'reject',
      unknown: 'allow',
    },
    quota: { max_concurrency: 2, max_rpm: 0, max_sessions: 0 },
    billing: { background: true, min_interval_sec: 1800 },
  }

  function edit(grok: Record<string, unknown>) {
    let next: Record<string, unknown> = {
      ...grok,
      enabled: true,
      base_url: 'https://api.x.ai',
    }
    next = setProtocolMode(next, 'anthropic.messages', 'convert')
    next = setClient(next, 'claude_code', true)
    next = setSub(next, 'quota', { max_concurrency: 7 })
    next = setSub(next, 'oauth', { refresh_skew_sec: 900 })
    next = setSub(next, 'billing', {
      background: false,
      min_interval_sec: 7200,
    })
    return next
  }

  it('the PUT body carries the edits and keeps untouched server values', () => {
    const draft = { sticky: {}, grok: serverGrok }
    const body = { ...draft, grok: edit(draft.grok) }
    const v = grokView(body.grok)
    expect(v).toMatchObject({
      enabled: true,
      baseUrl: 'https://api.x.ai',
      refreshSkewSec: 900,
      maxConcurrency: 7,
      maxRpm: 0,
      billingBackground: false,
      billingIntervalMin: 120,
    })
    expect(v.protocols['anthropic.messages']).toBe('convert')
    expect(v.protocols['openai.chat']).toBe('native')
    expect(v.clients.claude_code).toBe('allow')
    const sent = body.grok as typeof serverGrok
    expect(sent.protocols['openai.responses']).toEqual({
      mode: 'native',
      enabled: true,
    })
    expect(sent.oauth.redirect_uri).toBe('')
    expect(grokIssues(body.grok)).toEqual([])
  })

  it('the reloaded form shows what the server saved, not defaults', () => {
    const saved = edit(serverGrok)
    const reloaded = grokView(saved)
    expect(reloaded).not.toEqual(grokView({}))
    expect(reloaded.enabled).toBe(true)
    expect(reloaded.maxConcurrency).toBe(7)
  })

  it('detects an old server that never returns grok', () => {
    expect(routingHasGrok({ sticky: {}, codex: {} })).toBe(false)
    expect(routingHasGrok({ grok: serverGrok })).toBe(true)
    expect(routingHasGrok(null)).toBe(false)
  })
})
