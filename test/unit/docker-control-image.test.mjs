import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('control-plane Dockerfiles build kin-api-kernel into image-bin', () => {
  for (const rel of ['Dockerfile', 'deploy/Dockerfile.arm64-control']) {
    const body = fs.readFileSync(path.join(root, rel), 'utf8')
    assert.match(body, /kin-api-kernel/, rel)
    assert.match(body, /kin-grok-kernel/, rel)
    assert.match(body, /api-kernel/, rel)
  }
})

test('docker entrypoint refreshes kin-api-kernel before Node starts', () => {
  const entry = fs.readFileSync(path.join(root, 'scripts/docker-entrypoint.sh'), 'utf8')
  assert.match(entry, /ensure_bin kin-api-kernel/)
  assert.match(entry, /ensure_bin kin-grok-kernel/)
  assert.match(entry, /KIN_API_KERNEL_BIN/)
})
