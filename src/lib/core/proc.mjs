import fs from 'node:fs'

/** Signal-0 probe; a missing or foreign process reads as not alive. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** `candidate` when it names an executable file, else ''. */
export function existingBin(candidate) {
  const bin = String(candidate || '').trim()
  if (!bin) return ''
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return bin
  } catch {
    return ''
  }
}
