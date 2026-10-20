/**
 * Grok Build 1.0.62 sampler headers, mirrored for the request log.
 * The slot kernel attaches these on the wire. Node does not send them itself
 * and never puts the access token in the kernel envelope.
 *
 * `user_agent_string_for`: `grok-shell/{version} ({os}; {arch})`.
 * `GrokRequestHeaders::apply` always sends conv/req/model/session/agent, even when empty.
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

export const GROK_CLI_VERSION = '1.0.62'
export const GROK_CLI_IDENTIFIER = 'grok-shell'
export const GROK_BILLING_CLIENT_MODE = 'headless'

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
 * Inference headers the kernel will send, without Authorization.
 * Billing (`x-grok-client-mode`) and device login (`x-grok-client-surface`) stay off this set.
 */
export function grokCliRequestHeaders({
  model = '',
  sessionId = '',
  requestId = '',
  agentId = '',
  version = GROK_CLI_VERSION,
} = {}) {
  const session = String(sessionId ?? '')
  return {
    'content-type': 'application/json',
    'user-agent': grokCliUserAgent(version),
    'x-grok-client-version': version,
    'x-grok-client-identifier': GROK_CLI_IDENTIFIER,
    'x-grok-conv-id': session,
    'x-grok-req-id': String(requestId ?? ''),
    'x-grok-model-override': String(model ?? ''),
    'x-grok-session-id': session,
    'x-grok-agent-id': String(agentId ?? ''),
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
