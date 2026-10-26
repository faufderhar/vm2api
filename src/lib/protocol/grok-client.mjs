/**
 * Grok Build 1.0.70 inference headers, mirrored for the request log.
 * The slot kernel attaches these on the wire (`grok-kernel/src/headers.rs`). Node does
 * not send them itself and never puts the access token in the kernel envelope.
 *
 * `user_agent_string_for`: `grok-shell/{version} ({os}; {arch})`.
 * conv/req/model/session/agent are always sent, even when empty.
 * Client mode: inference is `headless` (official `grok -p`); the model list and billing
 * are TUI reads and say `interactive`. The kernel applies the same split.
 */
import crypto from 'node:crypto'
import os from 'node:os'
import {
  extractCallerSession,
  extractFirstUserIdentity,
  outboundSessionMode,
  resolveOutboundSessionId,
} from '../identity/identity-rewrite.mjs'
import { clientIp } from '../pool/sticky-router.mjs'

export const GROK_CLI_VERSION = '1.0.70'
export const GROK_CLI_IDENTIFIER = 'grok-shell'
export const GROK_INFERENCE_CLIENT_MODE = 'headless'
export const GROK_TUI_CLIENT_MODE = 'interactive'
/** Billing is a TUI read. Kept under the old name for callers. */
export const GROK_BILLING_CLIENT_MODE = GROK_TUI_CLIENT_MODE
export const GROK_TOKEN_AUTH = 'xai-grok-cli'

/** Same namespace as `ID_NAMESPACE` in the kernel. */
const GROK_ID_NAMESPACE = Buffer.from('5c0b7e2a419d4f638a1e6d27b390c458', 'hex')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** RFC 4122 v5 (SHA-1) UUID of `name` in the gateway's Grok namespace. */
export function grokUuidV5(name) {
  const hash = crypto.createHash('sha1').update(GROK_ID_NAMESPACE).update(String(name)).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The slot's agent id as sent: a stored UUID as is, an older hex seed as its stable v5 UUID. */
export function grokAgentUuid(seed) {
  const text = String(seed ?? '').trim()
  if (!text) return ''
  if (UUID_RE.test(text)) return text.toLowerCase()
  return grokUuidV5(`agent:${text}`)
}

/** One conversation group per (agent, conversation), stable across its turns. */
export function grokConvGroupId(agentId, sessionId) {
  return grokUuidV5(`conv-group:${agentId ?? ''}:${sessionId ?? ''}`)
}

function isToolResultOnly(content) {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((part) => part?.type === 'tool_result' || part?.type === 'function_call_output')
  )
}

/**
 * 1-based user turn of this request: how many user messages it carries, not counting
 * Anthropic user messages that only return tool results. Never below 1.
 */
export function grokTurnIndex(body = {}) {
  let turns = 0
  const rows = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (row.role !== 'user') continue
    if (row.type && row.type !== 'message') continue
    if (isToolResultOnly(row.content)) continue
    turns += 1
  }
  return Math.max(1, turns)
}

/** macos / windows / linux, and arm64 written as aarch64. Same buckets as the kernel. */
export function grokPlatformInfo(platform = os.platform(), arch = os.arch()) {
  const osName = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return { os: osName, arch: cpu }
}

export function grokCliUserAgent(version = GROK_CLI_VERSION, platform = grokPlatformInfo()) {
  return `grok-shell/${version} (${platform.os}; ${platform.arch})`
}

/**
 * Inference headers the kernel will send, without Authorization, in the kernel's order.
 * `x-grok-user-id` is added by the kernel from the slot credential and is not mirrored.
 */
export function grokCliRequestHeaders({
  model = '',
  sessionId = '',
  requestId = '',
  agentId = '',
  turnIdx = 1,
  convGroupId = '',
  version = GROK_CLI_VERSION,
  platform = grokPlatformInfo(),
} = {}) {
  const session = String(sessionId ?? '')
  const agent = grokAgentUuid(agentId)
  return {
    'content-type': 'application/json',
    'user-agent': grokCliUserAgent(version, platform || grokPlatformInfo()),
    'x-grok-client-mode': GROK_INFERENCE_CLIENT_MODE,
    'x-xai-token-auth': GROK_TOKEN_AUTH,
    'x-authenticateresponse': 'authenticate-response',
    'x-grok-client-version': version,
    'x-grok-client-identifier': GROK_CLI_IDENTIFIER,
    'x-grok-conv-group-id': String(convGroupId || grokConvGroupId(agent, session)),
    'x-grok-conv-id': session,
    'x-grok-req-id': String(requestId ?? ''),
    'x-grok-model-override': String(model ?? ''),
    'x-grok-session-id': session,
    'x-grok-agent-id': agent,
    'x-grok-turn-idx': String(Math.max(1, Math.trunc(Number(turnIdx)) || 1)),
    accept: 'text/event-stream',
    'x-grok-doom-loop-check': '1024',
    'x-grok-exact-repetition-check': '64',
  }
}

function firstUserText(body = {}) {
  const fromMessages = extractFirstUserIdentity(body?.messages)
  if (fromMessages) return fromMessages
  if (typeof body?.input === 'string') return body.input
  if (!Array.isArray(body?.input)) return ''
  for (const item of body.input) {
    if (typeof item === 'string' && item.trim()) return item
    if (typeof item?.content === 'string' && item.content.trim()) return item.content
    if (typeof item?.text === 'string' && item.text.trim()) return item.text
  }
  return ''
}

/**
 * Same rebuild / passthrough rule as Codex. A sticky hit on the same slot
 * reuses the id already sent upstream; otherwise one id is minted for this
 * attempt and stored when the attempt succeeds.
 */
export function resolveGrokOutboundSession({
  req,
  inbound = {},
  body = {},
  routing = {},
  vmId = '',
  bound = null,
  epoch = '',
} = {}) {
  const callerSession = extractCallerSession({ inbound, body, headers: req?.headers || {} })
  const mode = outboundSessionMode(routing)
  const sessionId = resolveOutboundSessionId(callerSession, {
    mode,
    officialClient: mode === 'passthrough',
    boundSessionId: bound?.sessionId || '',
    boundVmId: bound?.vmId || '',
    vmId,
    accountId: vmId,
    firstUserIdentity: firstUserText(body) || firstUserText(inbound),
    clientIp: clientIp(req),
    userAgent: req?.headers?.['user-agent'] || '',
    apiKeyId: req?.apiKeyId || '',
    epoch: epoch || 'pending',
    routing,
  })
  return { callerSession, sessionId: String(sessionId || '').trim() }
}

export function grokRequestId() {
  return crypto.randomUUID()
}
