/**
 * refusal_guards — persisted AUP fingerprints. Lookup before hop; remember after refusal.
 * signature is the user-text MinHash used for the near-duplicate check.
 * Rows are scoped by owner. '' is the platform owner. nearest() reads at most
 * NEAREST_SCAN_LIMIT of that owner's newest signatures, and remember() prunes.
 */
import { decodeSignature, REFUSAL_SIMILARITY, signatureSimilarity } from '../../core/refusal-similarity.mjs'
import { getDb } from '../database.mjs'

export const REFUSAL_OWNER_ROW_CAP = 2000
export const NEAREST_SCAN_LIMIT = 2000

export function refusalOwnerKey(owner) {
  if (owner && typeof owner === 'object') {
    if (owner.type === 'user') return String(owner.userId || owner.ownerUserId || '').trim()
    return ''
  }
  return String(owner || '').trim()
}

function rowToRec(row) {
  if (!row) return null
  return {
    owner_user_id: row.owner_user_id || '',
    fingerprint: row.fingerprint,
    model: row.model,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    error_message: row.error_message,
    preview: row.preview,
    expires_at: row.expires_at || null,
    signature: row.signature || null,
  }
}

export class RefusalGuardsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM refusal_guards WHERE owner_user_id = ? AND fingerprint = ?')
    this._insert = db.prepare(`
      INSERT INTO refusal_guards (
        owner_user_id, fingerprint, model, first_seen_at, last_seen_at, hit_count,
        source_request_id, error_message, preview, expires_at, signature
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, fingerprint) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        error_message = COALESCE(excluded.error_message, refusal_guards.error_message),
        preview = COALESCE(excluded.preview, refusal_guards.preview),
        signature = COALESCE(excluded.signature, refusal_guards.signature),
        expires_at = CASE
          WHEN refusal_guards.expires_at IS NULL THEN NULL
          WHEN excluded.expires_at IS NULL THEN NULL
          ELSE excluded.expires_at
        END
    `)
    this._hit = db.prepare(`
      UPDATE refusal_guards SET hit_count = hit_count + 1, last_seen_at = ?
      WHERE owner_user_id = ? AND fingerprint = ?
    `)
    this._list = db.prepare(
      `SELECT owner_user_id, fingerprint, model, first_seen_at, last_seen_at, hit_count,
              source_request_id, error_message, preview, expires_at
       FROM refusal_guards ORDER BY last_seen_at DESC, fingerprint LIMIT ?`,
    )
    this._signatures = db.prepare(
      `SELECT fingerprint, signature FROM refusal_guards
       WHERE owner_user_id = ? AND signature IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY last_seen_at DESC
       LIMIT ?`,
    )
    this._count = db.prepare('SELECT COUNT(*) AS n FROM refusal_guards')
    this._countOwner = db.prepare('SELECT COUNT(*) AS n FROM refusal_guards WHERE owner_user_id = ?')
    this._remove = db.prepare('DELETE FROM refusal_guards WHERE owner_user_id = ? AND fingerprint = ?')
    this._removeAllOwners = db.prepare('DELETE FROM refusal_guards WHERE fingerprint = ?')
    this._clear = db.prepare('DELETE FROM refusal_guards')
    this._deleteExpired = db.prepare(
      `DELETE FROM refusal_guards
       WHERE owner_user_id = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    this._trim = db.prepare(
      `DELETE FROM refusal_guards
       WHERE owner_user_id = ?
         AND rowid NOT IN (
           SELECT rowid FROM refusal_guards
           WHERE owner_user_id = ?
           ORDER BY last_seen_at DESC, fingerprint DESC
           LIMIT ?
         )`,
    )
  }

  get(fingerprint, owner = '') {
    const rec = rowToRec(this._get.get(refusalOwnerKey(owner), String(fingerprint || '')))
    if (!rec?.expires_at) return rec
    if (Date.parse(rec.expires_at) > Date.now()) return rec
    this.remove(rec.fingerprint, rec.owner_user_id)
    return null
  }

  remember({
    fingerprint,
    model = '',
    requestId = null,
    errorMessage = null,
    preview = null,
    expiresAt = null,
    signature = null,
    ownerUserId = '',
    owner = ownerUserId,
  } = {}) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return null
    const ownerKey = refusalOwnerKey(owner)
    const now = new Date().toISOString()
    this._insert.run(
      ownerKey,
      fp,
      String(model || ''),
      now,
      now,
      requestId,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
      preview ? String(preview).slice(0, 240) : null,
      expiresAt || null,
      signature || null,
    )
    this.prune(ownerKey)
    return this.get(fp, ownerKey)
  }

  hit(fingerprint, owner = '') {
    const fp = String(fingerprint || '').trim()
    if (!fp) return null
    const ownerKey = refusalOwnerKey(owner)
    this._hit.run(new Date().toISOString(), ownerKey, fp)
    return this.get(fp, ownerKey)
  }

  /** Highest stored user-text signature at or above the threshold, for this owner only. */
  nearest(signature, threshold = REFUSAL_SIMILARITY, owner = '') {
    const query = Array.isArray(signature) ? signature : decodeSignature(signature)
    if (!query) return null
    const ownerKey = refusalOwnerKey(owner)
    let best = null
    for (const row of this._signatures.all(ownerKey, new Date().toISOString(), NEAREST_SCAN_LIMIT)) {
      const score = signatureSimilarity(query, decodeSignature(row.signature))
      if (score < threshold) continue
      if (!best || score > best.score) best = { fingerprint: row.fingerprint, score }
    }
    if (!best) return null
    const rec = this.get(best.fingerprint, ownerKey)
    if (!rec) return null
    return { ...rec, score: best.score }
  }

  /** Drop expired rows, then the oldest past cap, for one owner. */
  prune(owner = '', cap = REFUSAL_OWNER_ROW_CAP) {
    const ownerKey = refusalOwnerKey(owner)
    const limit = Math.max(1, Number(cap) || REFUSAL_OWNER_ROW_CAP)
    this._deleteExpired.run(ownerKey, new Date().toISOString())
    this._trim.run(ownerKey, ownerKey, limit)
    return this.countOwner(ownerKey)
  }

  list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    const now = Date.now()
    return this._list
      .all(n)
      .map(rowToRec)
      .filter((rec) => !rec.expires_at || Date.parse(rec.expires_at) > now)
  }

  count() {
    return Number(this._count.get()?.n) || 0
  }

  countOwner(owner = '') {
    return Number(this._countOwner.get(refusalOwnerKey(owner))?.n) || 0
  }

  remove(fingerprint, owner = '') {
    const fp = String(fingerprint || '').trim()
    if (!fp) return false
    return this._remove.run(refusalOwnerKey(owner), fp).changes > 0
  }

  /** Delete this fingerprint for every owner. Returns how many rows were removed. */
  removeAllOwners(fingerprint) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return 0
    return this._removeAllOwners.run(fp).changes
  }

  clear() {
    return this._clear.run().changes
  }
}
