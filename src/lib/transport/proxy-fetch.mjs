/**
 * Small fetch helpers that egress through a slot proxy (socks5 → socks5h so DNS resolves remotely).
 */
import fetch from 'node-fetch'
import { createProxyAgent } from '../vm/proxy-agent.mjs'

export async function readFetchBody(res) {
  if (
    res &&
    Object.prototype.hasOwnProperty.call(res, 'body') &&
    res.body &&
    typeof res.body === 'object' &&
    !res.body.pipe
  ) {
    return res.body
  }
  if (typeof res?.json === 'function') {
    try {
      return await res.json()
    } catch {
      return null
    }
  }
  if (typeof res?.text === 'function') {
    const text = await res.text()
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  return null
}

export function makeProxyFetch(proxyUrl, timeoutMs = 15000, { maxMs = 30000 } = {}) {
  const px = String(proxyUrl || '')
    .trim()
    .replace(/^socks5:\/\//i, 'socks5h://')
  const ms = Math.min(Math.max(Number(timeoutMs) || 15000, 3000), maxMs)
  return (url, init = {}) => {
    // Build the agent before arming the timer, so a bad proxy URL throws without leaking it.
    const agent = px ? createProxyAgent(px) : undefined
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), ms)
    const opts = { ...init, signal: ac.signal }
    if (agent) opts.agent = agent
    return fetch(url, opts).finally(() => clearTimeout(timer))
  }
}
