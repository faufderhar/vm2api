import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { tryServeWebDist } from '../../src/lib/http/web-dist.mjs'

function mockRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

test('serves Vite index at /console and assets from web/dist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-web-'))
  const dist = path.join(root, 'web', 'dist', 'assets')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), '<!doctype html><title>ok</title>')
  fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1)')

  const html = mockRes()
  assert.equal(tryServeWebDist(html, root, '/console'), true)
  assert.equal(html.status, 200)
  assert.match(String(html.headers['content-type']), /text\/html/)
  assert.match(String(html.body), /ok/)

  const js = mockRes()
  assert.equal(tryServeWebDist(js, root, '/assets/app.js'), true)
  assert.equal(js.status, 200)
  assert.match(String(js.headers['content-type']), /javascript/)
})

test('caches hashed assets forever but never the index or unhashed files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-web-cache-'))
  const dist = path.join(root, 'web', 'dist')
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(dist, 'model-icons'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), 'x')
  fs.writeFileSync(path.join(dist, 'assets', 'index-Ab12.js'), 'x')
  fs.writeFileSync(path.join(dist, 'model-icons', 'openai.svg'), '<svg/>')

  const serve = (p) => {
    const res = mockRes()
    assert.equal(tryServeWebDist(res, root, p), true)
    return res.headers['cache-control']
  }
  assert.equal(serve('/console'), 'no-store')
  assert.equal(serve('/cc'), 'no-store')
  assert.equal(serve('/cc/'), 'no-store')
  assert.equal(serve('/index.html'), 'no-store')
  assert.match(serve('/assets/index-Ab12.js'), /immutable/)
  assert.doesNotMatch(serve('/model-icons/openai.svg'), /immutable/)
})

test('rejects missing dist, traversal, and /health', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-web-empty-'))
  assert.equal(tryServeWebDist(mockRes(), root, '/console'), false)

  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), 'x')
  assert.equal(tryServeWebDist(mockRes(), root, '/health'), false)
  assert.equal(tryServeWebDist(mockRes(), root, '/../package.json'), false)
})

test('serves the documented /cc entry as the console index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-web-cc-'))
  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), '<!doctype html><title>cc</title>')
  for (const entry of ['/cc', '/cc/', '/console', '/console/']) {
    const res = mockRes()
    assert.equal(tryServeWebDist(res, root, entry), true, entry)
    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-type']), /text\/html/)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.match(String(res.body), /cc/)
  }
  assert.equal(tryServeWebDist(mockRes(), root, '/cc%'), false)
  assert.equal(tryServeWebDist(mockRes(), root, '/cc%ZZ'), false)
})

test('the console page cannot be framed or run inline or remote script', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-web-csp-'))
  fs.mkdirSync(path.join(root, 'web', 'dist', 'assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(root, 'web', 'dist', 'assets', 'app.js'), '1')
  const html = mockRes()
  tryServeWebDist(html, root, '/cc')
  const csp = html.headers['content-security-policy']
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /object-src 'none'/)
  assert.equal(html.headers['x-frame-options'], 'DENY')
  assert.equal(html.headers['x-content-type-options'], 'nosniff')
  const js = mockRes()
  tryServeWebDist(js, root, '/assets/app.js')
  assert.equal(js.headers['x-content-type-options'], 'nosniff')
  assert.equal(js.headers['content-security-policy'], undefined)
})
