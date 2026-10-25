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
  // IETF protocol assignments (192.0.0.0/24). The benchmarking block 198.18.0.0/15
  // is left alone on purpose: fake-ip DNS (Clash and similar) maps every public
  // name into it, so blocking it would reject real upstreams after DNS checks.
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return 'private'
  // Multicast, reserved 240/4 and broadcast are never a proxy.
  if (parts[0] >= 224) return 'reserved'
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
  // RFC 8215 local-use NAT64 prefix 64:ff9b:1::/48 keeps the IPv4 in the last 32 bits.
  const nat64Local = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1
  if (mapped || translated || compatible || nat64 || nat64Local) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
  }
  // 6to4 (2002::/16) carries the relay's IPv4 in groups 1–2.
  if (g[0] === 0x2002) return [g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff].join('.')
  // Teredo (2001:0::/32) carries the client IPv4, bit-inverted, in groups 6–7.
  if (g[0] === 0x2001 && g[1] === 0) {
    const a = ~g[6] & 0xffff
    const b = ~g[7] & 0xffff
    return [a >> 8, a & 0xff, b >> 8, b & 0xff].join('.')
  }
  return ''
}

function ipv6Kind(host) {
  const g = ipv6Groups(host)
  if (g.every((x) => x === 0)) return 'unspecified'
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback'
  const v4 = embeddedIpv4(g)
  if (v4) return v4 === '100.100.100.200' ? 'metadata' : ipv4Kind(v4)
  if ((g[0] & 0xffc0) === 0xfe80) return 'linklocal'
  if ((g[0] & 0xfe00) === 0xfc00) return 'ula'
  // Deprecated site-local fec0::/10 is still routed inside some networks.
  if ((g[0] & 0xffc0) === 0xfec0) return 'ula'
  // Multicast and discard-only 100::/64.
  if ((g[0] & 0xff00) === 0xff00) return 'reserved'
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return 'reserved'
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

const HARD_BLOCK = new Set(['unspecified', 'linklocal', 'metadata', 'reserved'])
const PRIVATE_BLOCK = new Set(['loopback', 'private', 'cgnat', 'ula'])

/**
 * Block metadata, link-local, loopback and private ranges.
 * Set VM2API_ALLOW_PRIVATE_PROXY=1 to keep a lab SOCKS on 127.0.0.1 or RFC1918.
 * Platform local egress (scheme local / px-local) is not a tenant SOCKS target.
 */
export function isUnsafeProxyHost(proxy) {
  if (platformLocalEgress(proxy)) return false
  // A trailing dot is the same name to the resolver: `127.0.0.1.`, `localhost.`.
  let host = String(proxyHost(proxy) || '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
  // An IPv6 zone id (`fe80::1%eth0`, `%25` URL-encoded) names a local interface:
  // never a proxy. The normalizer drops such a host to '' (so the dial fails
  // today), but the policy must say so itself rather than lean on that (L-10).
  if (String(proxy?.host || '').includes('%') || /^[a-z0-9+.-]+:\/\/[^/]*\[[^\]]*%/i.test(String(proxy?.url || ''))) {
    return true
  }
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
function proxyBlockError(reason, status = 409) {
  const message =
    reason === 'ipv6_disabled'
      ? 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口'
      : '代理地址不能指向本机、内网、链路本地地址或云主机元数据'
  return Object.assign(new Error(message), { code: reason, status })
}

/**
 * Replace the hostname with the address that was just checked.
 * Do not use URL.toString(): a socks5h URL gains a trailing slash and the dialer rejects it.
 * An address that is already an IP is returned unchanged, so stored config is not rewritten.
 */
export function pinSocksProxyUrl(raw, ip) {
  const text = String(raw || '').trim()
  const address = String(ip || '').trim()
  if (!text || !net.isIP(address)) return text
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return text
  }
  const current = normalizeSocksHost(parsed.hostname)
  if (!current || net.isIP(current)) return text
  const pinned = net.isIPv6(address) ? `[${address}]` : address
  const schemeEnd = text.indexOf('://')
  if (schemeEnd < 0) return text
  const afterScheme = text.slice(schemeEnd + 3)
  const slash = afterScheme.search(/[/?#]/)
  const authority = slash < 0 ? afterScheme : afterScheme.slice(0, slash)
  const tail = slash < 0 ? '' : afterScheme.slice(slash)
  const at = authority.lastIndexOf('@')
  const userinfo = at >= 0 ? authority.slice(0, at + 1) : ''
  const hostport = at >= 0 ? authority.slice(at + 1) : authority
  const portMatch = hostport.match(/:(\d+)$/)
  const port = portMatch ? `:${portMatch[1]}` : ''
  return `${text.slice(0, schemeEnd + 3)}${userinfo}${pinned}${port}${tail}`
}

function lookupAnswers(value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((answer) => String(answer?.address || answer || '').trim()).filter(Boolean)
}

/**
 * Literal check, then DNS. Failure or an empty answer is a block.
 * Any resolved address that is unsafe blocks the name. When IPv6 is off, the
 * first safe IPv4 is chosen; IPv6-only answers are `ipv6_disabled`.
 * Platform local egress skips DNS. The returned url is only for the dial, not for storage.
 */
export async function resolvedProxyDial(proxy, { lookup, distinguishUnresolvable = false } = {}) {
  const unresolvable = distinguishUnresolvable ? 'proxy_host_unresolvable' : 'proxy_host_blocked'
  const literal = proxyBlockedReason(proxy)
  if (literal) return { blocked: literal, url: '', address: '' }
  if (platformLocalEgress(proxy)) return { blocked: null, url: '', address: '', local: true }
  const host = String(proxyHost(proxy) || '')
  const rawUrl = String(proxy?.url || '')
  if (!host || net.isIP(host)) return { blocked: null, url: rawUrl, address: net.isIP(host) ? host : '' }
  const lookupFn = lookup || ((name) => dns.lookup(name, { all: true, verbatim: true }))
  let answers
  try {
    answers = lookupAnswers(await lookupFn(host))
  } catch {
    return { blocked: unresolvable, url: '', address: '' }
  }
  if (!answers.length) return { blocked: unresolvable, url: '', address: '' }
  const ipv6Enabled = configuredIpv6Enabled()
  let chosen = ''
  let sawIpv6 = false
  // Check every answer first: one unsafe address blocks the name even when a
  // public one comes earlier (the resolver may hand the dialer either).
  for (const address of answers) {
    if (isUnsafeProxyHost({ host: address })) return { blocked: 'proxy_host_blocked', url: '', address: '' }
  }
  for (const address of answers) {
    const family = net.isIP(address)
    if (family === 6 && ipv6Enabled !== true) {
      sawIpv6 = true
      continue
    }
    if (!chosen || family === 4) chosen = address
    if (family === 4) break
  }
  if (!chosen) return { blocked: sawIpv6 ? 'ipv6_disabled' : 'proxy_host_blocked', url: '', address: '' }
  return { blocked: null, url: pinSocksProxyUrl(rawUrl, chosen) || rawUrl, address: chosen }
}

/** Names that look public can still resolve to loopback. DNS failure is a block. */
export async function proxyResolvedBlockReason(proxy, opts) {
  const dial = await resolvedProxyDial(proxy, opts)
  return dial.blocked
}

/**
 * Write-time check for a proxy row (create, import, edit): the literal rule,
 * then what the name resolves to. Returns null when the row may be stored,
 * 'proxy_host_blocked' when it points at a private/loopback/metadata address,
 * or 'proxy_host_unresolvable' when the name does not resolve (fail closed,
 * but reported apart so a typo is not mistaken for a policy block).
 * IPv6-only answers with IPv6 off are left to the dial-time check.
 */
export async function proxyWriteBlockReason(proxy, opts = {}) {
  const dial = await resolvedProxyDial(proxy, { ...opts, distinguishUnresolvable: true })
  if (dial.blocked === 'proxy_host_blocked' || dial.blocked === 'proxy_host_unresolvable') return dial.blocked
  return null
}

/** Resolve `proxyUrl` and return the socks URL pinned to the checked address. */
export async function assertProxyResolved(proxyUrl, opts = {}) {
  if (!proxyUrl) return ''
  const dial = await resolvedProxyDial({ url: proxyUrl }, opts)
  if (dial.blocked) throw proxyBlockError(dial.blocked, opts.status || 409)
  return dial.url || proxyUrl
}

/** Kernel handoff. Empty means this host's local egress and is not looked up. */
export function assertKernelProxyResolved(_vm, proxyUrl, opts) {
  return assertProxyResolved(proxyUrl, opts)
}
