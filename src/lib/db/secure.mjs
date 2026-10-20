/**
 * Optional at-rest encryption for credential fields in the DB
 * (sub2api AESEncryptor counterpart, zero-dependency node:crypto).
 *
 * Enabled when VM2API_DB_SECRET (or KIN_DB_SECRET) is set: AES-256-GCM, key = SHA-256(secret).
 * Format: enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 * Without the secret, values are stored as-is (matching the previous
 * plaintext-file-with-0600 behavior).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PREFIX = 'enc:v1:'
let persistedSecret

function dataDir() {
  return process.env.KIN_DATA_DIR || process.env.VM2API_DATA_DIR || ''
}

/** Key lives beside the data directory, not inside the file that it encrypts. */
export function dbSecretPath(dir = dataDir()) {
  if (!dir) return ''
  return path.join(path.dirname(dir), 'secrets', 'db.secret')
}

function legacyDbSecretPath(dir = dataDir()) {
  if (!dir) return ''
  return path.join(dir, 'db.secret')
}

function dbSecret() {
  return process.env.VM2API_DB_SECRET || process.env.KIN_DB_SECRET || readPersistedDbSecret()
}

/** Env always wins. Then secrets/db.secret, then a leftover data/db.secret. */
function readPersistedDbSecret() {
  if (persistedSecret) return persistedSecret
  for (const file of [dbSecretPath(), legacyDbSecretPath()]) {
    if (!file) continue
    try {
      const secret = fs.readFileSync(file, 'utf8').trim()
      if (!secret) continue
      persistedSecret = secret
      return secret
    } catch {
      // try the next location
    }
  }
  return ''
}

function readSecretFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function writeSecretFile(file, secret) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // mode on writeFile already asked for 0600
  }
}

/**
 * Create the at-rest key outside the SQLite directory.
 * An older data/db.secret is copied once and removed so a data-dir copy no longer includes it.
 */
export function ensureDbSecretFile(dir) {
  if (process.env.VM2API_DB_SECRET || process.env.KIN_DB_SECRET) return
  const next = dbSecretPath(dir)
  const previous = legacyDbSecretPath(dir)
  if (!next) return
  if (readSecretFile(next)) return
  const legacy = readSecretFile(previous)
  const secret = legacy || crypto.randomBytes(32).toString('hex')
  writeSecretFile(next, secret)
  persistedSecret = secret
  if (legacy) {
    try {
      fs.rmSync(previous)
    } catch {
      // The new file is already the one readers prefer.
    }
    console.warn('[db] moved data/db.secret to secrets/db.secret so a data-directory copy does not include the key')
    return
  }
  console.warn('[db] wrote secrets/db.secret; credential columns are encrypted at rest')
}

export function encryptionEnabled() {
  return !!dbSecret()
}

function deriveKey(secret = dbSecret()) {
  return crypto.createHash('sha256').update(String(secret)).digest()
}

export function encryptString(plain, secret = dbSecret()) {
  if (plain == null) return null
  const key = deriveKey(secret)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decryptString(value, secret = dbSecret()) {
  if (value == null) return null
  const s = String(value)
  if (!s.startsWith(PREFIX)) return s
  const [ivB64, tagB64, ctB64] = s.slice(PREFIX.length).split(':')
  const key = deriveKey(secret)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const out = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()])
  return out.toString('utf8')
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** Encrypt when a secret is configured; otherwise return as-is. */
export function maybeEncrypt(plain) {
  if (plain == null) return null
  return encryptionEnabled() ? encryptString(plain) : String(plain)
}

/** Decrypt when the value carries the enc prefix; otherwise return as-is. */
export function maybeDecrypt(value) {
  if (value == null) return null
  return isEncrypted(value) ? decryptString(value) : String(value)
}
