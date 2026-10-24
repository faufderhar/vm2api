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
  return scheme === 'local'
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
  if (parts[0] === 0) return 'unspecified'
  if (parts[0] === 127) return 'loopback'
  if (parts[0] === 10) return 'private'
  if (parts[0] === 192 && parts[1] === 168) return 'private'
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 'private'
  if (parts[0] === 169 && parts[1] === 254) return 'linklocal'
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 'cgnat'
  return ''
}

/** Eight 16-bit groups of a valid IPv6 literal, a trailing dotted IPv4 included. */
function ipv6Groups(host) {
  let text = host
  const tail = []
  const dotted = text.match(/:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const p = dotted[1].split('.').map(Number)
    tail.push((p[0] << 8) | p[1], (p[2] << 8) | p[3])
    text = `${text.slice(0, -dotted[1].length)}0`
  }
  const [left, right] = text.split('::')
  const parse = (part) => (part ? part.split(':').map((g) => Number.parseInt(g, 16)) : [])
  const head = parse(left)
  const rest = right === undefined ? [] : parse(right)
  if (dotted) (rest.length ? rest : head).pop()
  const fill = 8 - tail.length - head.length - rest.length
  return [...head, ...Array(Math.max(0, fill)).fill(0), ...rest, ...tail]
}

/** IPv4-mapped, IPv4-compatible, SIIT and NAT64 forms reach the embedded IPv4 address. */
function embeddedIpv4(g) {
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0)
  const mapped = zero(0, 5) && g[5] === 0xffff
  const translated = zero(0, 4) && g[4] === 0xffff && g[5] === 0
  const compatible = zero(0, 6) && (g[6] !== 0 || g[7] > 1)
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)
  if (!mapped && !translated && !compatible && !nat64) return ''
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
}

function ipv6Kind(host) {
  const g = ipv6Groups(host)
  if (g.every((x) => x === 0)) return 'unspecified'
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback'
  const v4 = embeddedIpv4(g)
  if (v4) return v4 === '100.100.100.200' ? 'metadata' : ipv4Kind(v4)
  if ((g[0] & 0xffc0) === 0xfe80) return 'linklocal'
  if ((g[0] & 0xfe00) === 0xfc00) return 'ula'
  return ''
}

/**
 * Shorthand IPv4 that getaddrinfo accepts as an address (`127.1`, `2130706433`,
 * `0x7f.0.0.1`, `0177.0.0.1`), as dotted quad; '' when the name is not one.
 */
function legacyIpv4(host) {
  const parts = host.split('.')
  if (parts.length > 4 || !/^[0-9a-fx.]+$/.test(host)) return ''
  const nums = parts.map((p) => {
    if (/^0x[0-9a-f]+$/.test(p)) return Number.parseInt(p.slice(2), 16)
    if (/^0[0-7]*$/.test(p)) return Number.parseInt(p, 8)
    if (/^[1-9]\d*$/.test(p)) return Number(p)
    return Number.NaN
  })
  if (nums.some((n) => !Number.isFinite(n))) return ''
  const last = nums.pop()
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return ''
  const value = nums.reduce((acc, n, i) => acc + n * 256 ** (3 - i), 0) + last
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.')
}

const HARD_BLOCK = new Set(['unspecified', 'linklocal', 'metadata'])
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
  if (host.startsWith('::ffff:') && net.isIPv4(host.slice('::ffff:'.length))) host = host.slice('::ffff:'.length)
  if (!net.isIP(host)) host = legacyIpv4(host) || host
  if (host === '100.100.100.200') return true
  const kind = net.isIPv4(host) ? ipv4Kind(host) : net.isIPv6(host) ? ipv6Kind(host) : ''
  if (!kind) return false
  if (HARD_BLOCK.has(kind)) return true
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
