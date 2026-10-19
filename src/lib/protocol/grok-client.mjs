/**
 * Outbound identity for the Grok hop, taken from the installed stable Grok CLI.
 * `grok update --check` on 2026-10-19 reported current and latest 1.0.62.
 *
 * Sampler (`xai-grok-sampler` client.rs) sends the version and client id on
 * every cli-chat-proxy call, and puts the conversation on `x-grok-session-id`
 * / `x-grok-conv-id`. The log column "出站 Session" is that id.
 */
import crypto from 'node:crypto'
import {
  extractCallerSession,
  extractFirstUserIdentity,
  outboundSessionMode,
  resolveOutboundSessionId,
} from '../identity/identity-rewrite.mjs'
import { clientIp } from '../pool/sticky-router.mjs'

export const GROK_CLI_VERSION = '1.0.62'
export const GROK_CLI_IDENTIFIER = 'grok-shell'
export const GROK_CLI_USER_AGENT_PREFIX = 'xai-grok-workspace'
export const GROK_CLI_TOKEN_AUTH = 'xai-grok-cli'
export const GROK_CLI_AUTHENTICATE_RESPONSE = 'authenticate-response'

export function grokCliUserAgent(version = GROK_CLI_VERSION) {
  return `${GROK_CLI_USER_AGENT_PREFIX}/${version}`
}

/** Static CLI identity. No conversation id; safe for GET /v1/models. */
export function grokCliIdentityHeaders(version = GROK_CLI_VERSION) {
  return {
    'user-agent': grokCliUserAgent(version),
    'x-grok-client-version': version,
    'x-grok-client-identifier': GROK_CLI_IDENTIFIER,
    'x-xai-token-auth': GROK_CLI_TOKEN_AUTH,
    'x-authenticateresponse': GROK_CLI_AUTHENTICATE_RESPONSE,
  }
}

/**
 * Headers for one inference call. Empty optional values are omitted so the
 * kernel does not forward blank header lines.
 */
export function grokCliRequestHeaders({
  model = '',
  sessionId = '',
  requestId = '',
  version = GROK_CLI_VERSION,
} = {}) {
  const headers = grokCliIdentityHeaders(version)
  const modelId = String(model || '').trim()
  const session = String(sessionId || '').trim()
  const request = String(requestId || '').trim()
  if (modelId) headers['x-grok-model-override'] = modelId
  if (session) {
    headers['x-grok-conv-id'] = session
    headers['x-grok-session-id'] = session
  }
  if (request) headers['x-grok-req-id'] = request
  return headers
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
