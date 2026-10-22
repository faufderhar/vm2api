/**
 * Grok access-token lifecycle. The slot's kin-grok-kernel is the only refresher: it
 * refreshes on demand before an upstream call, and here when the panel asks for it.
 * Node never posts the refresh token itself, so xAI sees one client per account.
 */
import { grokKernelOauthTransport } from './grok-kernel-oauth.mjs'
import { persistGrokCredentialState, persistGrokRefreshRejected, readGrokAccount } from '../vm/grok-slot.mjs'

/**
 * Ask the kernel for a usable bearer, refreshing when stale or when `force` is set.
 * Returns { ok, account, refreshed } or { ok: false, code }. The token stays in the file.
 */
export async function ensureGrokAccessToken({ projectRoot, vm, routing, force = false, transport } = {}) {
  const vmId = String(vm?.id || '')
  if (!projectRoot || !vmId) return { ok: false, code: 'grok_no_credential' }
  const account = readGrokAccount(projectRoot, vmId)
  if (!account || (!account.access_token && !account.refresh_token)) return { ok: false, code: 'grok_no_credential' }
  const call = transport || grokKernelOauthTransport({ projectRoot, vm, routing })
  let res
  try {
    res = await call({ action: 'refresh', force })
  } catch (error) {
    res = { error: error?.code || 'grok_refresh_failed' }
  }
  if (res?.error) {
    if (res.error === 'refresh_rejected') {
      persistGrokRefreshRejected(projectRoot, vmId)
      return { ok: false, code: 'grok_refresh_rejected' }
    }
    if (res.error === 'grok_token_expired' || res.error === 'grok_no_credential') return { ok: false, code: res.error }
    const passthrough = ['grok_oauth_not_configured', 'grok_oauth_discovery_failed', 'proxy_required']
    return { ok: false, code: passthrough.includes(res.error) ? res.error : 'grok_refresh_failed' }
  }
  const refreshed = res?.payload?.refreshed === true
  const next = readGrokAccount(projectRoot, vmId) || account
  persistGrokCredentialState(projectRoot, vmId, next, {
    auth_error: null,
    ...(refreshed ? { last_refresh_at: new Date().toISOString() } : {}),
  })
  return { ok: true, account: next, refreshed }
}
