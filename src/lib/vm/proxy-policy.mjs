import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import net from 'node:net'
import dns from 'node:dns/promises'
import { normalizeSocksHost, socksProxyFamily } from './socks-address.mjs'

export function configuredIpv6Enabled() {
  return isDbOpen() && new SettingsRepo(getDb()).get('proxy_pool_config')?.ipv6_enabled === true
}

/** Loopback and RFC1918 stay usable only when an operator opts in. Metadata never does. */
export function privateProxyAllowed(env = process.env) {
  return String(env.VM2API_ALLOW_PRIVATE_PROXY || '').trim() === '1'
}

// Same keys and order as egress.mjs LOCAL_PROXY_ENV_KEYS. Importing it here would be a cycle.
const DEPLOYMENT_PROXY_ENV_KEYS = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'])
const DEFAULT_PROXY_PORTS = Object.freeze({ 'socks5:': '1080', 'socks5h:': '1080', 'http:': '80', 'https:': '443' })
const platformEndpoints = new Set()

function endpointKey(host, port) {
  const name = normalizeSocksHost(host).trim().toLowerCase()
  const number = String(port || '').trim()
  return name && number ? `${name}:${number}` : ''
}

function urlEndpoint(raw) {
  try {
    const url = new URL(String(raw || ''))
    return endpointKey(url.hostname, url.port || DEFAULT_PROXY_PORTS[url.protocol])
  } catch {
    return ''
  }
}

/**
 * A SOCKS listener this process opened for itself, such as the node egress front.
 * Its loopback URL is the platform's own route, not a tenant proxy. Returns an unregister function.
 */
export function registerPlatformEgressEndpoint(host, port) {
  const key = endpointKey(host, port)
  if (!key) return () => {}
  platformEndpoints.add(key)
  return () => platformEndpoints.delete(key)
}

/** A proxy URL the platform resolved itself: a registered listener or the deployment proxy env. */
function platformEgressUrl(proxy, env = process.env) {
  if (!proxy?.url) return false
  const key = urlEndpoint(proxy.url)
  if (!key) return false
  if (platformEndpoints.has(key)) return true
  return DEPLOYMENT_PROXY_ENV_KEYS.some((name) => {
    const value = String(env?.[name] || '').trim()
    return !!value && urlEndpoint(value) === key
  })
}

function platformLocalEgress(proxy) {
  if (platformEgressUrl(proxy)) return true
  const id = String(proxy?.id || '').trim()
  if (id === 'px-local' || id.startsWith('px-local-')) return true
  const scheme = String(proxy?.scheme || proxy?.kind || '')
    .trim()
    .toLowerCase()
  const host = String(proxy?.host || '')
    .trim()
    .toLowerCase()
  return scheme === 'local' || host === 'local'
}

function proxyHost(proxy) {
  if (proxy?.url) {
    try {
      return normalizeSocksHost(new URL(proxy.url).hostname)
    } catch {
      return ''
    }
  }
  return normalizeSocksHost(proxy?.host)
}

function ipv4Kind(host) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return ''
  if (parts.every((part) => part === 0)) return 'unspecified'
  if (parts[0] === 127) return 'loopback'
  if (parts[0] === 10) return 'private'
  if (parts[0] === 192 && parts[1] === 168) return 'private'
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 'private'
  if (parts[0] === 169 && parts[1] === 254) return 'linklocal'
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 'cgnat'
  return ''
}

function ipv6Kind(host) {
  if (host === '::' || host === '::0') return 'unspecified'
  if (host === '::1') return 'loopback'
  if (host.startsWith('::ffff:')) return ipv4Kind(host.slice('::ffff:'.length))
  const head = host.split(':')[0]
  if (/^fe[89ab][0-9a-f]{0,2}$/.test(head)) return 'linklocal'
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return 'ula'
  return ''
}

const HARD_BLOCK = new Set(['unspecified', 'linklocal'])
const PRIVATE_BLOCK = new Set(['loopback', 'private', 'cgnat', 'ula'])

/**
 * Block metadata, link-local, loopback and private ranges.
 * Set VM2API_ALLOW_PRIVATE_PROXY=1 to keep a lab SOCKS on 127.0.0.1 or RFC1918.
 * Platform local egress (scheme local / px-local) is not a tenant SOCKS target.
 */
export function isUnsafeProxyHost(proxy) {
  if (platformLocalEgress(proxy)) return false
  let host = String(proxyHost(proxy) || '')
    .trim()
    .toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return !privateProxyAllowed()
  if (
    host === 'metadata.google.internal' ||
    host.endsWith('.metadata.google.internal') ||
    host === 'metadata.internal' ||
    host === 'instance-data'
  ) {
    return true
  }
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length)
  const kind = net.isIPv4(host) ? ipv4Kind(host) : net.isIPv6(host) ? ipv6Kind(host) : ''
  if (!kind) return false
  if (HARD_BLOCK.has(kind)) return true
  if (host === '100.100.100.200') return true
  return PRIVATE_BLOCK.has(kind) && !privateProxyAllowed()
}

export function proxyBlockedReason(proxy, ipv6Enabled = configuredIpv6Enabled()) {
  if (isUnsafeProxyHost(proxy)) return 'proxy_host_blocked'
  return ipv6Enabled !== true && socksProxyFamily(proxy) === 6 ? 'ipv6_disabled' : null
}

export function assertProxyAllowed(proxy) {
  const reason = proxyBlockedReason(proxy)
  if (!reason) return
  const message =
    reason === 'ipv6_disabled'
      ? 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口'
      : '代理地址不能指向本机、内网、链路本地地址或云主机元数据'
  throw Object.assign(new Error(message), { code: reason, status: 409 })
}

/** Names that look public can still resolve to loopback. Call before opening the proxy. */
export async function proxyResolvedBlockReason(proxy) {
  const literal = proxyBlockedReason(proxy)
  if (literal) return literal
  if (platformLocalEgress(proxy)) return null
  const host = String(proxyHost(proxy) || '')
  if (!host || net.isIP(host)) return null
  let answers
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    return null
  }
  for (const answer of answers || []) {
    if (isUnsafeProxyHost({ host: answer.address })) return 'proxy_host_blocked'
  }
  return null
}
