/**
 * Pieces shared by the two in-slot official CLI PTY flows
 * (`claude auth login` and `claude setup-token`): the session status file,
 * pid probes, the CAI authorize URL extractor and the poll loop.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from '../core/clock.mjs'

export function codedError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** Repository scripts/ (the PTY drivers live there). */
export function scriptsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts')
}

/** The manual CAI authorize URL printed by the official CLI, from raw PTY output. */
export function extractCaiAuthorizeUrl(raw = '') {
  const text = String(raw || '')
  const osc = text.match(/\x1b\]8;[^;]*;(https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\x07]+)\x07/)
  if (osc?.[1]) return osc[1].trim()
  const stripped = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
  const compact = stripped.replace(/\s+/g, '')
  const m = compact.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?[A-Za-z0-9_\-.=&%+]+/)
  return m ? m[0] : ''
}

export function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll `fn` until it returns a truthy value or `timeoutMs` passes (then null). Throws from `fn` propagate. */
export async function waitFor(fn, timeoutMs, intervalMs = 200) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = fn()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

/** Public view of a PTY session's status.json. */
export function ptySessionView(status, vmId, { alive, flavor, source }) {
  const expired = Number(status.expires_at || 0) && Date.now() > Number(status.expires_at)
  return {
    session_id: status.session_id || '',
    vm_id: status.vm_id || vmId,
    status: status.status || '',
    auth_url: status.auth_url || '',
    error: status.error || null,
    code_fed: !!status.code_fed,
    created_at: status.created_at || 0,
    updated_at: status.updated_at || 0,
    expires_at: status.expires_at || 0,
    flavor,
    source,
    alive,
    expired: !!expired,
  }
}
