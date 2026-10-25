/**
 * Grok 设置页的纯逻辑：默认值、读草稿、校验、写回。和后端
 * `src/lib/protocol/grok-route.mjs` 一一对应——这里不发明网关没有的开关。
 *
 * 后端仍保留但面板不再展示的字段（原样透传，不会被清掉）：
 * - `oauth.authorize_url` / `redirect_uri` / `extra_authorize_params`：只给 PKCE 授权码流程用，
 *   面板的 Grok 登录走设备码，没有路由会调用 PKCE。
 * - `websocket.enabled`：没有代码读它；Grok 不支持 Responses WebSocket，WS 入口直接拒绝。
 */

type Block = Record<string, unknown>

export const GROK_DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com'
export const GROK_DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_DEFAULT_SCOPE =
  'openid profile email offline_access grok-cli:access api:access'

export const GROK_LIMITS = {
  refresh_skew_sec: { min: 30, max: 3600, fallback: 300 },
  max_concurrency: { min: 1, max: 256, fallback: 2 },
  max_rpm: { min: 0, max: 1_000_000, fallback: 0 },
  max_sessions: { min: 0, max: 256, fallback: 0 },
  /** 面板按分钟编辑；后端存秒（1800–86400）。 */
  billing_interval_min: { min: 30, max: 1440, fallback: 30 },
} as const

export type GrokProtocolKey =
  | 'openai.responses'
  | 'openai.chat'
  | 'openai.completions'
  | 'anthropic.messages'
export type GrokProtocolMode = 'native' | 'convert' | 'reject'

export const GROK_PROTOCOLS: {
  key: GrokProtocolKey
  label: string
  path: string
  modes: GrokProtocolMode[]
  fallback: GrokProtocolMode
  note?: string
}[] = [
  {
    key: 'openai.responses',
    label: 'OpenAI Responses',
    path: '/v1/responses',
    modes: ['native', 'reject'],
    fallback: 'native',
  },
  {
    key: 'openai.chat',
    label: 'OpenAI Chat Completions',
    path: '/v1/chat/completions',
    modes: ['native', 'reject'],
    fallback: 'native',
  },
  {
    key: 'anthropic.messages',
    label: 'Claude Messages',
    path: '/v1/messages',
    modes: ['native', 'convert', 'reject'],
    fallback: 'reject',
    note: '转换：按 Codex 同款规则把 Messages 转成 Responses 再发给 Grok。',
  },
  {
    key: 'openai.completions',
    label: 'OpenAI Completions（旧版）',
    path: '/v1/completions',
    modes: ['reject'],
    fallback: 'reject',
    note: 'Grok 上游不提供旧版 Completions，固定拒绝。',
  },
]

export const GROK_MODE_LABEL: Record<GrokProtocolMode, string> = {
  native: '原生转发',
  convert: '转换为 Responses',
  reject: '拒绝',
}

export type GrokClientKey =
  'official_codex' | 'openai_compatible' | 'claude_code' | 'unknown'

export const GROK_CLIENTS: {
  key: GrokClientKey
  label: string
  desc: string
  fallback: 'allow' | 'reject'
}[] = [
  {
    key: 'official_codex',
    label: 'Codex 官方客户端',
    desc: 'UA / originator 是 codex，或带 x-codex-installation-id、session-id 头。',
    fallback: 'allow',
  },
  {
    key: 'openai_compatible',
    label: 'OpenAI 兼容客户端',
    desc: 'OpenAI SDK、带 openai-beta 头，或请求体是 messages / input 形状。',
    fallback: 'allow',
  },
  {
    key: 'claude_code',
    label: 'Claude Code',
    desc: 'UA 是 claude-cli / claude-code。默认拒绝，避免 Claude 流量误落 Grok。',
    fallback: 'reject',
  },
  {
    key: 'unknown',
    label: '其它 / 无法识别',
    desc: '以上都不匹配的请求。',
    fallback: 'allow',
  },
]

export function asBlock(value: unknown): Block {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Block)
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function intOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) ? n : fallback
}

export type GrokView = {
  enabled: boolean
  baseUrl: string
  tokenUrl: string
  clientId: string
  scope: string
  refreshSkewSec: number
  protocols: Record<GrokProtocolKey, GrokProtocolMode>
  clients: Record<GrokClientKey, 'allow' | 'reject'>
  maxConcurrency: number
  maxRpm: number
  maxSessions: number
  billingBackground: boolean
  billingIntervalMin: number
}

/** 草稿 → 面板读数。缺省值与后端 DEFAULT_GROK_ROUTING 一致。 */
export function grokView(grok: Block): GrokView {
  const oauth = asBlock(grok.oauth)
  const protocols = asBlock(grok.protocols)
  const clients = asBlock(grok.clients)
  const quota = asBlock(grok.quota)
  const billing = asBlock(grok.billing)
  const proto = {} as GrokView['protocols']
  for (const row of GROK_PROTOCOLS) {
    const mode = asBlock(protocols[row.key]).mode
    proto[row.key] = row.modes.includes(mode as GrokProtocolMode)
      ? (mode as GrokProtocolMode)
      : Object.prototype.hasOwnProperty.call(protocols, row.key)
        ? 'reject'
        : row.fallback
  }
  const cli = {} as GrokView['clients']
  for (const row of GROK_CLIENTS) {
    const v = clients[row.key]
    cli[row.key] = v === 'allow' || v === 'reject' ? v : row.fallback
  }
  const L = GROK_LIMITS
  return {
    enabled: grok.enabled === true,
    baseUrl:
      grok.base_url == null ? GROK_DEFAULT_BASE_URL : text(grok.base_url),
    tokenUrl: text(oauth.token_url),
    clientId: text(oauth.client_id),
    scope: text(oauth.scope),
    refreshSkewSec: intOr(oauth.refresh_skew_sec, L.refresh_skew_sec.fallback),
    protocols: proto,
    clients: cli,
    maxConcurrency: intOr(quota.max_concurrency, L.max_concurrency.fallback),
    maxRpm: intOr(quota.max_rpm, L.max_rpm.fallback),
    maxSessions: intOr(quota.max_sessions, L.max_sessions.fallback),
    billingBackground: billing.background !== false,
    billingIntervalMin: Math.round(
      intOr(billing.min_interval_sec, L.billing_interval_min.fallback * 60) / 60
    ),
  }
}

function hostIn(url: URL, domains: string[]) {
  const host = url.hostname.toLowerCase()
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/** 与后端 isGrokBaseUrl 同规则：https，主机在 grok.com / x.ai 下，不带用户名密码。 */
export function isGrokBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (
      url.protocol === 'https:' &&
      hostIn(url, ['grok.com', 'x.ai']) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/** 与后端 isGrokOauthEndpoint 同规则：https *.x.ai，或本机回环（本地 mock IdP）。 */
export function isGrokOauthEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim())
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
      url.hostname.toLowerCase()
    )
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (loopback) return true
    return url.protocol === 'https:' && hostIn(url, ['x.ai'])
  } catch {
    return false
  }
}

export type GrokIssue = { field: 'base_url' | 'token_url'; message: string }

/** 保存前的本地校验；后端也会以同样规则拒绝（invalid_grok_*）。 */
export function grokIssues(grok: Block | undefined): GrokIssue[] {
  if (!grok) return []
  const view = grokView(grok)
  const out: GrokIssue[] = []
  if (!isGrokBaseUrl(view.baseUrl)) {
    out.push({
      field: 'base_url',
      message: view.baseUrl.trim()
        ? '上游地址必须是 https://*.grok.com 或 https://*.x.ai，且不带用户名密码'
        : '上游地址不能为空，可点「恢复默认」',
    })
  }
  if (view.tokenUrl.trim() && !isGrokOauthEndpoint(view.tokenUrl)) {
    out.push({
      field: 'token_url',
      message: '换票地址必须是 https://*.x.ai 或本机回环地址；留空则自动发现',
    })
  }
  return out
}

export function setProtocolMode(
  grok: Block,
  key: GrokProtocolKey,
  mode: GrokProtocolMode
): Block {
  const protocols = asBlock(grok.protocols)
  return {
    ...grok,
    protocols: {
      ...protocols,
      [key]: { ...asBlock(protocols[key]), mode, enabled: mode !== 'reject' },
    },
  }
}

export function setClient(
  grok: Block,
  key: GrokClientKey,
  allow: boolean
): Block {
  return {
    ...grok,
    clients: { ...asBlock(grok.clients), [key]: allow ? 'allow' : 'reject' },
  }
}

export function setSub(
  grok: Block,
  section: 'oauth' | 'quota' | 'billing',
  patch: Block
): Block {
  return { ...grok, [section]: { ...asBlock(grok[section]), ...patch } }
}

export function fmtInterval(min: number): string {
  if (min % 60 === 0) return `${min / 60} 小时`
  return min > 60
    ? `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`
    : `${min} 分钟`
}
