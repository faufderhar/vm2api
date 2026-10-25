import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')

function fetchPayload(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-payload-'))
  const manifest = path.join(dir, 'payload.json')
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      repo: 'dofastted/vm2api',
      release: 'payload-x',
      files: [{ path: 'bin/a', asset: 'a', size: 1, sha256: '0' }],
    }),
  )
  // Record the URL instead of touching the network.
  const hook = path.join(dir, 'hook.mjs')
  fs.writeFileSync(
    hook,
    "globalThis.fetch = async (url) => { console.log('URL ' + url); return new Response('', { status: 404 }) }\n",
  )
  const out = spawnSync(
    process.execPath,
    ['--import', hook, path.join(root, 'scripts/fetch-payload.mjs'), '--manifest', manifest, '--dest', dir],
    {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    },
  )
  fs.rmSync(dir, { recursive: true, force: true })
  return `${out.stdout}${out.stderr}`
}

test('L-5: fetch-payload follows VM2API_GITHUB_REPO, else the manifest repo', () => {
  assert.match(fetchPayload({}), /URL https:\/\/github\.com\/dofastted\/vm2api\/releases\/download\/payload-x\/a/)
  assert.match(
    fetchPayload({ VM2API_GITHUB_REPO: 'me/fork' }),
    /URL https:\/\/github\.com\/me\/fork\/releases\/download\/payload-x\/a/,
  )
  assert.match(fetchPayload({ VM2API_GITHUB_REPO: 'evil.example/../x y' }), /must be owner\/repo/)
})

test('L-5: install.sh reads an installed fork repo from .env when the env var is not passed through sudo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-install-'))
  fs.writeFileSync(path.join(dir, '.env'), 'X=1\nVM2API_GITHUB_REPO="me/vm2api-fork"\r\n')
  const src = fs.readFileSync(path.join(root, 'deploy/install.sh'), 'utf8')
  const start = src.indexOf('# An installed fork keeps its repo in .env')
  const end = src.indexOf('INSTALL_DIR=', start)
  const snippet = `set -euo pipefail\n${src.slice(start, end)}\necho "REPO=$GITHUB_REPO"\n`
  const run = (env) =>
    spawnSync('bash', ['-c', snippet], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).stdout
  assert.match(run({ VM2API_DIR: dir }), /REPO=me\/vm2api-fork/)
  assert.match(run({ VM2API_DIR: dir, VM2API_GITHUB_REPO: 'other/repo' }), /REPO=other\/repo/)
  assert.match(run({ VM2API_DIR: path.join(dir, 'missing') }), /REPO=dofastted\/vm2api/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('L-5: image builds pass the fork repo to the payload stage', () => {
  for (const f of ['Dockerfile', 'deploy/Dockerfile.arm64-control']) {
    assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /ARG VM2API_GITHUB_REPO=/, f)
  }
  for (const f of ['docker-compose.build.yml', 'docker-compose.arm64.yml']) {
    assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /VM2API_GITHUB_REPO: \$\{VM2API_GITHUB_REPO:-\}/, f)
  }
})
