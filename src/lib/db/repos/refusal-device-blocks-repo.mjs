/**
 * Ban of an inbound client device_id after a refusal-guard hit.
 * Empty ids are never stored. The ban is limited to the owner who saw it:
 * the device id is chosen by the client, so it must not cross tenants.
 * '' is the platform owner. This is not the slot's outbound device.
 */
import { getDb } from '../database.mjs'
import { refusalOwnerKey } from './refusal-guards-repo.mjs'

export const REFUSAL_DEVICE_ROW_CAP = 5000

function rowToRec(row) {
  if (!row) return null
  return {
    owner_user_id: row.owner_user_id || '',
    device_id: row.device_id,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    fingerprint: row.fingerprint,
    reason: row.reason,
  }
}

export class RefusalDeviceBlocksRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM refusal_device_blocks WHERE owner_user_id = ? AND device_id = ?')
    this._insert = db.prepare(`
      INSERT INTO refusal_device_blocks (
        owner_user_id, device_id, first_seen_at, last_seen_at, hit_count,
        source_request_id, fingerprint, reason
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(owner_user_id, device_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        source_request_id = COALESCE(refusal_device_blocks.source_request_id, excluded.source_request_id),
        fingerprint = COALESCE(refusal_device_blocks.fingerprint, excluded.fingerprint),
        reason = COALESCE(refusal_device_blocks.reason, excluded.reason)
    `)
    this._hit = db.prepare(`
      UPDATE refusal_device_blocks SET hit_count = hit_count + 1, last_seen_at = ?
      WHERE owner_user_id = ? AND device_id = ?
    `)
    this._list = db.prepare('SELECT * FROM refusal_device_blocks ORDER BY last_seen_at DESC, device_id LIMIT ?')
    this._count = db.prepare('SELECT COUNT(*) AS n FROM refusal_device_blocks')
    this._countOwner = db.prepare('SELECT COUNT(*) AS n FROM refusal_device_blocks WHERE owner_user_id = ?')
    this._remove = db.prepare('DELETE FROM refusal_device_blocks WHERE owner_user_id = ? AND device_id = ?')
    this._clear = db.prepare('DELETE FROM refusal_device_blocks')
    this._trim = db.prepare(
      `DELETE FROM refusal_device_blocks
       WHERE owner_user_id = ?
         AND rowid NOT IN (
           SELECT rowid FROM refusal_device_blocks
           WHERE owner_user_id = ?
           ORDER BY last_seen_at DESC, device_id DESC
           LIMIT ?
         )`,
    )
  }

  get(deviceId, owner = '') {
    const id = String(deviceId || '').trim()
    if (!id) return null
    return rowToRec(this._get.get(refusalOwnerKey(owner), id))
  }

  block({
    deviceId,
    requestId = null,
    fingerprint = null,
    reason = 'refusal_guard',
    ownerUserId = '',
    owner = ownerUserId,
  } = {}) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    const ownerKey = refusalOwnerKey(owner)
    const now = new Date().toISOString()
    this._insert.run(ownerKey, id, now, now, requestId, fingerprint, reason ? String(reason).slice(0, 80) : null)
    this.prune(ownerKey)
    return this.get(id, ownerKey)
  }

  hit(deviceId, owner = '') {
    const id = String(deviceId || '').trim()
    if (!id) return null
    const ownerKey = refusalOwnerKey(owner)
    this._hit.run(new Date().toISOString(), ownerKey, id)
    return this.get(id, ownerKey)
  }

  prune(owner = '', cap = REFUSAL_DEVICE_ROW_CAP) {
    const ownerKey = refusalOwnerKey(owner)
    const limit = Math.max(1, Number(cap) || REFUSAL_DEVICE_ROW_CAP)
    this._trim.run(ownerKey, ownerKey, limit)
    return Number(this._countOwner.get(ownerKey)?.n) || 0
  }

  list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    return this._list.all(n).map(rowToRec)
  }

  count() {
    return Number(this._count.get()?.n) || 0
  }

  remove(deviceId, owner = '') {
    const id = String(deviceId || '').trim()
    if (!id) return false
    return this._remove.run(refusalOwnerKey(owner), id).changes > 0
  }

  clear() {
    return this._clear.run().changes
  }
}
