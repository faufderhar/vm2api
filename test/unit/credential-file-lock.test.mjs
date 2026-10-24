import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readWorkerCredentialFile, writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'

const HOLD = `
import fcntl, os, sys, time
lock_path, ready_path, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(ready_path, 'w').close()
time.sleep(seconds)
`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('writeWorkerCredentialFile waits for credentials.json.lock', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cred-lock-'))
  const file = path.join(home, '.claude', 'credentials.json')
  const lock = `${file}.lock`
  const ready = path.join(home, 'held')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const child = spawn(process.env.KIN_PYTHON || 'python3', ['-c', HOLD, lock, ready, '0.45'], { stdio: 'ignore' })
  const deadline = Date.now() + 2000
  while (!fs.existsSync(ready)) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error('lock holder did not start')
    }
    await sleep(10)
  }
  const started = Date.now()
  try {
    const written = writeWorkerCredentialFile(home, {
      access_token: 'access-locked',
      refresh_token: 'refresh-locked',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
    const elapsed = Date.now() - started
    assert.equal(written, file)
    assert.ok(elapsed >= 300, `write returned in ${elapsed}ms while credentials.json.lock was held`)
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'refresh-locked')
  } finally {
    child.kill('SIGKILL')
    fs.rmSync(home, { recursive: true, force: true })
  }
})
