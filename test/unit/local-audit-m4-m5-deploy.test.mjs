import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { warnPublicPlainListen } from '../../src/lib/core/security.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('M5: release repo follows VM2API_GITHUB_REPO and rejects anything but owner/repo', async () => {
  const { resolveGithubRepo, DEFAULT_GITHUB_REPO } = await import('../../src/lib/admin/release.mjs')
  assert.equal(DEFAULT_GITHUB_REPO, 'dofastted/vm2api')
  assert.equal(resolveGithubRepo({}), 'dofastted/vm2api')
  assert.equal(resolveGithubRepo({ VM2API_GITHUB_REPO: 'faufderhar/vm2api' }), 'faufderhar/vm2api')
  for (const bad of ['x/../y', 'bad', 'a/b;rm -rf /', 'a/b c', 'https://github.com/a/b', '/a/b']) {
    assert.equal(resolveGithubRepo({ VM2API_GITHUB_REPO: bad }), 'dofastted/vm2api', bad)
  }
})

test('M5: a fork repo flows into the release URLs, the upgrade command and the kernel allowlist', async () => {
  const prev = process.env.VM2API_GITHUB_REPO
  process.env.VM2API_GITHUB_REPO = 'faufderhar/vm2.api'
  try {
    const release = await import(`../../src/lib/admin/release.mjs?fork=${Date.now()}`)
    assert.equal(release.GITHUB_REPO, 'faufderhar/vm2.api')
    assert.equal(
      release.INSTALL_SCRIPT_URL,
      'https://raw.githubusercontent.com/faufderhar/vm2.api/main/deploy/install.sh',
    )
    assert.match(
      release.upgradeCommand('v1.2.3'),
      /\| sudo VM2API_GITHUB_REPO=faufderhar\/vm2\.api bash -s -- upgrade --version v1\.2\.3$/,
    )
  } finally {
    if (prev == null) delete process.env.VM2API_GITHUB_REPO
    else process.env.VM2API_GITHUB_REPO = prev
  }
  const { upgradeCommand } = await import('../../src/lib/admin/release.mjs')
  assert.doesNotMatch(upgradeCommand('v1.2.3'), /VM2API_GITHUB_REPO/)
})

test('M4: compose lets the operator bind loopback and documents pinning the image', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
  assert.match(compose, /HOST: \$\{VM2API_BIND_HOST:-0\.0\.0\.0\}/)
  assert.doesNotMatch(compose, /HOST: 0\.0\.0\.0\n/)
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8')
  for (const name of ['VM2API_GITHUB_REPO', 'VM2API_IMAGE', 'VM2API_IMAGE_TAG', 'VM2API_BIND_HOST']) {
    assert.match(example, new RegExp(`# ${name}=`), name)
  }
})

test('M4: listening on every interface without TLS warns once at startup', () => {
  const seen = []
  const warn = (m) => seen.push(m)
  assert.equal(warnPublicPlainListen('0.0.0.0', {}, warn), true)
  assert.equal(warnPublicPlainListen('127.0.0.1', {}, warn), false)
  assert.equal(warnPublicPlainListen('0.0.0.0', { PUBLIC_BASE_URL: 'https://gw.example' }, warn), false)
  assert.equal(warnPublicPlainListen('0.0.0.0', { PUBLIC_SCHEME: 'https' }, warn), false)
  assert.equal(seen.length, 1)
  assert.match(seen[0], /VM2API_BIND_HOST=127\.0\.0\.1/)
})
