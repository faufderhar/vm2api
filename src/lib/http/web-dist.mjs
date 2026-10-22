import fs from 'node:fs'
import path from 'node:path'

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function distRoot(projectRoot) {
  return path.resolve(projectRoot, 'web', 'dist')
}

function safeFile(root, rel) {
  const resolved = path.resolve(root, rel)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (resolved !== root && !resolved.startsWith(prefix)) return ''
  try {
    if (!fs.statSync(resolved).isFile()) return ''
  } catch {
    return ''
  }
  return resolved
}

// 安装脚本和文档的入口是 /cc#/login（hash 路由，服务端只看到 /cc）。
// /console 是旧入口，继续认。这两条都落到 index.html，且不能进长期缓存。
const CONSOLE_ENTRIES = new Set(['/cc', '/cc/', '/console', '/console/'])

export function isConsoleEntry(pathname) {
  return CONSOLE_ENTRIES.has(String(pathname || ''))
}

function relativePath(pathname) {
  const raw = String(pathname || '')
  if (CONSOLE_ENTRIES.has(raw)) return 'index.html'
  // 非法 % 序列不应冒泡成 500；当找不到文件处理。
  try {
    return decodeURIComponent(raw.replace(/^\/+/, ''))
  } catch {
    return ''
  }
}

// Vite 把内容哈希写进 assets/ 下的文件名，内容变了 URL 就变，可以永久缓存；
// index.html 必须每次重新取，才能拿到新的哈希文件名。
function cacheControl(rel, ext) {
  if (ext === '.html') return 'no-store'
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable'
  return 'public, max-age=86400'
}

// The console is a Vite bundle: no inline or remote script, never framed. connect-src stays
// open because a panel may point at a saved cross-origin API base (PANEL_CORS_ORIGINS).
export const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: http: wss: ws:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

function securityHeaders(ext) {
  const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' }
  if (ext === '.html') {
    headers['content-security-policy'] = PANEL_CSP
    headers['x-frame-options'] = 'DENY'
  }
  return headers
}

export function tryServeWebDist(res, projectRoot, pathname) {
  const root = distRoot(projectRoot)
  try {
    if (!fs.statSync(root).isDirectory()) return false
  } catch {
    return false
  }

  const rel = relativePath(pathname)
  if (!rel || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return false

  const file = safeFile(root, rel)
  if (!file) return false

  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': cacheControl(rel, ext),
    ...securityHeaders(ext),
  })
  res.end(fs.readFileSync(file))
  return true
}
