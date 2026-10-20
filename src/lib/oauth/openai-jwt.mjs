/**
 * Decode OpenAI / ChatGPT OAuth JWT claims (access_token / id_token).
 * Used for panel account labels and chatgpt-account-id headers — not auth validation.
 */

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

/** Numeric epoch (seconds or ms) or ISO-ish string for subscription-until claims. */
export function firstStringOrEpoch(...values) {
  for (const value of values) {
    if (value == null || value === '') continue
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value < 1e12 ? value * 1000 : value
      const iso = new Date(ms).toISOString()
      if (Number.isFinite(Date.parse(iso))) return iso
      continue
    }
    const text = String(value).trim()
    if (!text) continue
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      const n = Number(text)
      if (Number.isFinite(n)) {
        const ms = n < 1e12 ? n * 1000 : n
        const iso = new Date(ms).toISOString()
        if (Number.isFinite(Date.parse(iso))) return iso
      }
    }
    return text
  }
  return ''
}

function authObjFromPayload(payload) {
  const auth = payload?.['https://api.openai.com/auth']
  return auth && typeof auth === 'object' ? auth : {}
}

function claimPresent(payload, authObj, key) {
  return Object.prototype.hasOwnProperty.call(payload, key) || Object.prototype.hasOwnProperty.call(authObj, key)
}

export function decodeJwtPayload(token) {
  try {
    const part = String(token || '')
      .trim()
      .split('.')[1]
    if (!part) return null
    const json = Buffer.from(part, 'base64url').toString('utf8')
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

function chatgptSubscriptionActiveUntilFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  const authObj = authObjFromPayload(payload)
  const raw = firstStringOrEpoch(payload.chatgpt_subscription_active_until, authObj.chatgpt_subscription_active_until)
  return raw || null
}

/** Id-token-only claims used when enriching Codex accounts (overwrite vs retain). */
export function openaiClaimsFromIdToken(idToken) {
  const payload = decodeJwtPayload(idToken)
  if (!payload) {
    return {
      has_chatgpt_subscription_active_until: false,
      chatgpt_subscription_active_until: null,
      has_chatgpt_plan_type: false,
      chatgpt_plan_type: null,
    }
  }
  const authObj = authObjFromPayload(payload)
  const has_chatgpt_subscription_active_until = claimPresent(payload, authObj, 'chatgpt_subscription_active_until')
  const has_chatgpt_plan_type = claimPresent(payload, authObj, 'chatgpt_plan_type')
  return {
    has_chatgpt_subscription_active_until,
    chatgpt_subscription_active_until: has_chatgpt_subscription_active_until
      ? chatgptSubscriptionActiveUntilFromPayload(payload)
      : null,
    has_chatgpt_plan_type,
    chatgpt_plan_type: has_chatgpt_plan_type
      ? firstString(payload.chatgpt_plan_type, authObj.chatgpt_plan_type) || null
      : null,
  }
}

export function openaiIdentityFromJwt(token) {
  const payload = decodeJwtPayload(token)
  if (!payload) return { email: null, chatgpt_account_id: null, chatgpt_subscription_active_until: null }
  const auth = payload['https://api.openai.com/auth']
  const authObj = auth && typeof auth === 'object' ? auth : {}
  const profile = payload['https://api.openai.com/profile']
  const profileObj = profile && typeof profile === 'object' ? profile : {}
  const email = firstString(
    payload.email,
    payload.email_address,
    payload.preferred_username,
    authObj.email,
    authObj.user_email,
    authObj.account_email,
    profileObj.email,
  )
  const chatgpt_account_id = firstString(authObj.chatgpt_account_id, authObj.account_id, authObj.user_id)
  return {
    email: email || null,
    chatgpt_account_id: chatgpt_account_id || null,
    chatgpt_subscription_active_until: chatgptSubscriptionActiveUntilFromPayload(payload),
  }
}

/** Prefer id_token (openid profile); fill gaps from access_token. */
export function openaiIdentityFromOauthTokens({ id_token, access_token, idToken, accessToken } = {}) {
  const fromId = openaiIdentityFromJwt(id_token || idToken)
  const fromAccess = openaiIdentityFromJwt(access_token || accessToken)
  return {
    email: firstString(fromId.email, fromAccess.email) || null,
    chatgpt_account_id: firstString(fromId.chatgpt_account_id, fromAccess.chatgpt_account_id) || null,
    chatgpt_subscription_active_until: fromId.chatgpt_subscription_active_until || null,
  }
}
