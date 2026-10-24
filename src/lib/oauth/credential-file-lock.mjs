/**
 * Advisory lock for the slot worker credential file.
 *
 * Same protocol as worker/internal/credential/store.go WithLock:
 * `<credentials.json>.lock`, flock(2) LOCK_EX|LOCK_NB, retry every 25ms.
 * The holder is a short-lived process so the kernel drops the lock if this
 * process dies. A timed-out wait throws; callers must not write unlocked.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const RETRY_MS = 25
const WAIT_MS = 30_000
const POLL_MS = 5

const LOCKER = `
import ctypes, fcntl, os, sys, time
lock_path, ready_path = sys.argv[1], sys.argv[2]
try:
    libc = ctypes.CDLL(None)
    libc.prctl(1, 15)
except Exception:
    pass
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
os.fchmod(fd, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)
ready = os.open(ready_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.close(ready)
while True:
    time.sleep(3600)
`

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function processAlive(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const match = stat.match(/\) (\S)/)
      if (!match) return false
      return match[1] !== 'Z' && match[1] !== 'X'
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function prepareLockFile(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
  } finally {
    fs.closeSync(fd)
  }
}

/** Hold credentials.json.lock across fn. fn runs only after LOCK_EX is acquired. */
export function withCredentialFileLock(lockPath, fn) {
  if (!lockPath) throw Object.assign(new Error('credential lock path is required'), { code: 'credential_lock_timeout' })
  prepareLockFile(lockPath)
  const deadline = Date.now() + WAIT_MS
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    const readyPath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${process.pid}.${attempt}.ready`)
    const child = spawn(process.env.KIN_PYTHON || 'python3', ['-c', LOCKER, lockPath, readyPath], {
      stdio: 'ignore',
    })
    child.unref()
    const slice = Math.min(deadline, Date.now() + 80)
    let held = false
    while (Date.now() < slice) {
      if (fs.existsSync(readyPath)) {
        held = true
        break
      }
      if (child.pid && !processAlive(child.pid)) break
      sleepSync(POLL_MS)
    }
    if (held) {
      try {
        return fn()
      } finally {
        try {
          child.kill('SIGKILL')
        } catch {}
        try {
          fs.rmSync(readyPath, { force: true })
        } catch {}
      }
    }
    try {
      child.kill('SIGKILL')
    } catch {}
    try {
      fs.rmSync(readyPath, { force: true })
    } catch {}
    const wait = Math.min(RETRY_MS, Math.max(0, deadline - Date.now()))
    if (wait > 0) sleepSync(wait)
  }
  throw Object.assign(new Error('timed out waiting for the credential file lock'), { code: 'credential_lock_timeout' })
}
