/**
 * Grok slot "seed" view: what this slot's kin-grok-kernel presents as the Grok CLI.
 * There is no Grok CLI home in the container; the client identity is the kernel config
 * under `vms/<id>/run/` plus fixed grok-shell constants. Read-only, no secrets:
 * the internal token is never returned and proxy credentials are dropped.
 */
import fs from 'node:fs'
import {
  GROK_BILLING_CLIENT_MODE,
  GROK_CLI_IDENTIFIER,
  GROK_CLI_VERSION,
  grokCliUserAgent,
} from '../protocol/grok-client.mjs'
import {
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_DISCOVERY_URL,
  grokBaseUrl,
  grokOauthConfig,
} from '../protocol/grok-route.mjs'
import { grokKernelHealth, grokKernelInFlight, grokKernelPaths } from '../transport/grok-kernel-supervisor.mjs'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function mtimeIso(file) {
  try {
    return fs.statSync(file).mtime.toISOString()
  } catch {
    return null
  }
}

/** `scheme://host:port` with the user / password dropped. */
export function publicProxyUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return { url: '', auth: false }
  try {
    const u = new URL(text)
    const auth = !!(u.username || u.password)
    return { url: `${u.protocol}//${u.host}`, auth }
  } catch {
    return { url: '', auth: false }
  }
}

function credentialSummary(file) {
  const body = readJson(file)
  const accounts = Array.isArray(body?.accounts) ? body.accounts : []
  const first = accounts[0] || {}
  return {
    present: accounts.length > 0,
    accounts: accounts.length,
    has_access: !!first.access_token,
    has_refresh: !!first.refresh_token,
    expires_at: first.expires_at || null,
    updated_at: first.updated_at || mtimeIso(file),
  }
}

export async function readGrokCliInfo(projectRoot, vm, { routing = {}, health = grokKernelHealth } = {}) {
  const paths = grokKernelPaths(projectRoot, vm.id)
  const config = readJson(paths.configPath)
  const oauth = grokOauthConfig(routing)
  const resolved = oauth.ok ? oauth.config : {}
  const kernelHealth = config ? await health(projectRoot, vm.id).catch(() => ({ ok: false })) : null
  // The kernel binary fixes the version; a running one reports it.
  const version = String(kernelHealth?.clientVersion || GROK_CLI_VERSION)
  const platform = config?.platform?.os && config?.platform?.arch ? config.platform : undefined
  const proxy = publicProxyUrl(config?.proxy_url)
  return {
    product: GROK_CLI_IDENTIFIER,
    client_version: version,
    user_agent: grokCliUserAgent(version, platform),
    billing_client_mode: GROK_BILLING_CLIENT_MODE,
    base_url: String(config?.base_url || grokBaseUrl(routing) || ''),
    agent_id: readText(paths.agentIdPath) || null,
    proxy: { url: proxy.url, auth: proxy.auth, required: config ? config.proxy_required !== false : null },
    oauth: {
      client_id: String(config?.oauth?.client_id || resolved.client_id || GROK_OAUTH_CLIENT_ID),
      discovery_url: String(config?.oauth?.discovery_url || GROK_OAUTH_DISCOVERY_URL),
      token_url: String(config?.oauth?.token_url || resolved.token_url || ''),
      refresh_skew_sec: Number(config?.oauth?.refresh_skew_sec) || Number(resolved.refresh_skew_sec) || 300,
    },
    credentials: credentialSummary(paths.credentialPath),
    kernel: {
      configured: !!config,
      config_written_at: mtimeIso(paths.configPath),
      ok: kernelHealth ? kernelHealth.ok === true : null,
      reason: kernelHealth && !kernelHealth.ok ? String(kernelHealth.reason || kernelHealth.status || '') : '',
      in_flight: grokKernelInFlight(vm.id),
    },
    files: {
      run_dir: paths.runDir,
      config: paths.configPath,
      credentials: paths.credentialPath,
    },
  }
}
