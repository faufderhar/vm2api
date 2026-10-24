import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { withCredentialFileLock } from '../../src/lib/oauth/credential-file-lock.mjs'
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

function holdLock(lock, ready, seconds) {
  const child = spawn(process.env.KIN_PYTHON || 'python3', ['-c', HOLD, lock, ready, String(seconds)], {
    stdio: 'ignore',
  })
  return child
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(10)
  }
}

test('an idle credential lock is acquired', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cred-lock-free-'))
  const lock = path.join(home, 'credentials.json.lock')
  const started = Date.now()
  try {
    const held = await withCredentialFileLock(lock, () => 'held')
    const elapsed = Date.now() - started
    assert.equal(held, 'held')
    assert.ok(elapsed < 5000, `idle lock took ${elapsed}ms`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('worker holds the lock, Node waits, and the event loop is not blocked', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cred-lock-wait-'))
  const lock = path.join(home, 'credentials.json.lock')
  const ready = path.join(home, 'held')
  fs.mkdirSync(home, { recursive: true })
  const child = holdLock(lock, ready, 0.45)
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 20)
  try {
    await waitUntil(() => fs.existsSync(ready), 2000)
    const started = Date.now()
    const held = await withCredentialFileLock(lock, () => 'held')
    const elapsed = Date.now() - started
    assert.equal(held, 'held')
    assert.ok(elapsed >= 250, `waited only ${elapsed}ms while the worker held the lock`)
    assert.ok(ticks >= 3, `event loop ticks during the wait: ${ticks}`)
  } finally {
    clearInterval(timer)
    child.kill('SIGKILL')
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('writeWorkerCredentialFile waits for credentials.json.lock', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cred-lock-'))
  const file = path.join(home, '.claude', 'credentials.json')
  const lock = `${file}.lock`
  const ready = path.join(home, 'held')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const child = holdLock(lock, ready, 0.45)
  try {
    await waitUntil(() => fs.existsSync(ready), 2000)
    const started = Date.now()
    const written = await writeWorkerCredentialFile(home, {
      access_token: 'access-locked',
      refresh_token: 'refresh-locked',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
    const elapsed = Date.now() - started
    assert.equal(written, file)
    assert.ok(elapsed >= 250, `write returned in ${elapsed}ms while credentials.json.lock was held`)
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'refresh-locked')
  } finally {
    child.kill('SIGKILL')
    fs.rmSync(home, { recursive: true, force: true })
  }
})
