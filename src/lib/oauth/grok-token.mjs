/**
 * Grok access-token lifecycle: proactive refresh before expiry, forced refresh after a 401.
 * Concurrent callers for one slot share one refresh (in-process promise + cross-process lock file).
 */
import fs from 'node:fs'
import path from 'node:path'
import { grokRoutingOf } from '../protocol/grok-route.mjs'
import { refreshGrokAccessToken } from './grok-oauth.mjs'
import { patchGrokBag, persistGrokCredentialState, readGrokAccount, upsertGrokAccount } from '../vm/grok-slot.mjs'

const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 15_000
const inflight = new Map()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lockPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'run', 'grok-refresh.lock')
}

async function withRefreshLock(projectRoot, vmId, fn) {
  const file = lockPath(projectRoot, vmId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 })
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      let age = 0
      try {
        age = Date.now() - fs.statSync(file).mtimeMs
      } catch {
        continue
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(file, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        const busy = new Error('grok refresh lock busy')
        busy.code = 'grok_refresh_busy'
        throw busy
      }
      await sleep(200)
    }
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(file, { force: true })
  }
}

function tokenFresh(account, skewMs, now) {
  if (!account?.access_token) return false
  const exp = Number(account.expires_at) || 0
  return !exp || exp - now > skewMs
}

function tokenUsable(account, now) {
  if (!account?.access_token) return false
  const exp = Number(account.expires_at) || 0
  return !exp || exp > now
}

function ok(account, refreshed) {
  return { ok: true, access_token: account.access_token, account, refreshed }
}

async function refreshLocked({ projectRoot, vmId, routing, proxyUrl, force, fetchImpl, seenUpdatedAt, skewMs }) {
  return withRefreshLock(projectRoot, vmId, async () => {
    const now = Date.now()
    const account = readGrokAccount(projectRoot, vmId)
    if (!account) return { ok: false, code: 'grok_no_credential' }
    // Another process refreshed while we waited for the lock.
    if (account.updated_at !== seenUpdatedAt && tokenFresh(account, force ? 0 : skewMs, now)) return ok(account, false)
    if (!account.refresh_token) {
      if (!force && tokenUsable(account, now)) return ok(account, false)
      return { ok: false, code: 'grok_token_expired' }
    }
    const res = await refreshGrokAccessToken({ routing, refreshToken: account.refresh_token, proxyUrl, fetchImpl })
    if (res.ok) {
      const next = upsertGrokAccount(projectRoot, vmId, {
        access_token: res.access_token,
        refresh_token: res.refresh_token,
        id_token: res.id_token || account.id_token,
        expires_at: res.expires_at,
      })
      persistGrokCredentialState(projectRoot, vmId, next, {
        auth_error: null,
        last_refresh_at: new Date().toISOString(),
      })
      return ok(next, true)
    }
    if (res.error === 'refresh_rejected') {
      patchGrokBag(projectRoot, vmId, (bag) => ({
        ...bag,
        auth_error: { code: 'oauth_refresh_rejected', message: 'xAI 拒绝了 refresh_token，请重新登录', at: now },
      }))
      return { ok: false, code: 'grok_refresh_rejected', status: res.status }
    }
    if (!force && tokenUsable(account, now)) return ok(account, false)
    const passthrough = res.error === 'grok_oauth_not_configured' || res.error === 'grok_oauth_discovery_failed' || res.error === 'proxy_required'
    return { ok: false, code: passthrough ? res.error : 'grok_refresh_failed', status: res.status }
  })
}

/**
 * A usable bearer for the slot, refreshing when it is within the skew window or `force` is set.
 * Returns { ok, access_token, account, refreshed } or { ok:false, code }.
 */
export async function ensureGrokAccessToken({ projectRoot, vm, routing, proxyUrl, force = false, fetchImpl } = {}) {
  const vmId = String(vm?.id || '')
  if (!projectRoot || !vmId) return { ok: false, code: 'grok_no_credential' }
  const skewMs = grokRoutingOf(routing).oauth.refresh_skew_sec * 1000
  const account = readGrokAccount(projectRoot, vmId)
  if (!account || (!account.access_token && !account.refresh_token)) return { ok: false, code: 'grok_no_credential' }
  if (!force && tokenFresh(account, skewMs, Date.now())) return ok(account, false)
  const key = `${vmId}:${force ? 'force' : 'skew'}`
  let pending = inflight.get(key)
  if (!pending) {
    pending = refreshLocked({
      projectRoot,
      vmId,
      routing,
      proxyUrl,
      force,
      fetchImpl,
      seenUpdatedAt: account.updated_at,
      skewMs,
    })
      .catch((err) => ({ ok: false, code: err?.code || 'grok_refresh_failed' }))
      .finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

export function resetGrokTokenInflight() {
  inflight.clear()
}
