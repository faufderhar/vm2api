/**
 * Advisory lock for the slot worker credential file.
 *
 * Same protocol as worker/internal/credential/store.go WithLock:
 * `<credentials.json>.lock`, flock(2) LOCK_EX|LOCK_NB, retry every 25ms,
 * give up after 30s and do not write.
 *
 * Node cannot call flock(2) itself. One python process (already installed
 * in the control-plane image) holds the lock for the whole critical section
 * and exits when stdin closes, which drops the lock on both Linux and macOS
 * if this process dies. Callers await so the wait is not Atomics.wait and
 * does not stall the event loop. A docker `kin-worker` write was rejected:
 * import and startup run while the slot container is down.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const RETRY_MS = 25
const WAIT_MS = 30_000

const LOCKER = `
import fcntl, os, select, sys, time
lock_path = sys.argv[1]
deadline = time.time() + float(sys.argv[2])
fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
os.fchmod(fd, 0o600)
while True:
    readable, _, _ = select.select([sys.stdin], [], [], 0)
    if readable and not os.read(0, 1024):
        sys.exit(0)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except OSError:
        if time.time() >= deadline:
            sys.exit(2)
        readable, _, _ = select.select([sys.stdin], [], [], ${RETRY_MS / 1000})
        if readable and not os.read(0, 1024):
            sys.exit(0)
sys.stdout.write('ready\\n')
sys.stdout.flush()
while os.read(0, 1024):
    pass
`

function lockError(message, code) {
  return Object.assign(new Error(message), { code })
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

function childExited(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code))
  })
}

/**
 * Hold credentials.json.lock across fn. fn runs only after LOCK_EX is held.
 * fn may be async. The event loop keeps running while another process holds the lock.
 */
export async function withCredentialFileLock(lockPath, fn) {
  if (!lockPath) throw lockError('credential lock path is required', 'credential_lock_timeout')
  prepareLockFile(lockPath)
  const child = spawn(process.env.KIN_PYTHON || 'python3', ['-c', LOCKER, lockPath, String(WAIT_MS / 1000)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
  child.stderr.on('data', () => {})
  child.stdin.on('error', () => {})
  let stdout = ''
  let settled = false
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve('timeout')
    }, WAIT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (settled || !stdout.includes('ready')) return
      settled = true
      clearTimeout(timer)
      resolve('ready')
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code === 2 ? 'timeout' : 'exit')
    })
  }).catch((error) => {
    try {
      child.kill('SIGKILL')
    } catch {}
    throw lockError(error?.message || 'credential lock helper failed', 'credential_lock_failed')
  })
  if (outcome !== 'ready') {
    try {
      child.kill('SIGKILL')
    } catch {}
    await childExited(child)
    throw lockError('timed out waiting for the credential file lock', 'credential_lock_timeout')
  }
  try {
    return await fn()
  } finally {
    try {
      child.stdin.end()
    } catch {}
    const exited = childExited(child)
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 2000)
    await exited
    clearTimeout(killer)
  }
}
