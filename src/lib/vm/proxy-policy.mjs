import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import net from 'node:net'
import { normalizeSocksHost, socksProxyFamily } from './socks-address.mjs'

export function configuredIpv6Enabled() {
  return isDbOpen() && new SettingsRepo(getDb()).get('proxy_pool_config')?.ipv6_enabled === true
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

/**
 * Block link-local and cloud metadata addresses.
 * 127.0.0.1 stays allowed: local SOCKS egress and dev proxies use it.
 */
export function isUnsafeProxyHost(proxy) {
  let host = String(proxyHost(proxy) || '')
    .trim()
    .toLowerCase()
  if (!host) return false
  if (
    host === 'metadata.google.internal' ||
    host.endsWith('.metadata.google.internal') ||
    host === 'metadata.internal' ||
    host === 'instance-data'
  ) {
    return true
  }
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length)
  if (host === '100.100.100.200') return true
  if (net.isIPv4(host)) {
    const parts = host.split('.').map(Number)
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts.every((part) => part === 0)) return true
    return false
  }
  if (!net.isIPv6(host)) return false
  if (host === '::') return true
  const head = host.split(':')[0]
  return /^fe[89ab][0-9a-f]$/.test(head)
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
      : '代理地址不能指向链路本地地址或云主机元数据'
  throw Object.assign(new Error(message), { code: reason, status: 409 })
}
