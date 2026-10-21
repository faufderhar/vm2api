/**
 * cluster_nodes repository — SSH-reachable VPS nodes.
 * Credentials are encrypted at rest via maybeEncrypt and never leave through
 * `list()` / `get()`; only `getSecrets()` returns them, for the connector.
 */

import { getDb } from '../database.mjs'
import { maybeDecrypt, maybeEncrypt } from '../secure.mjs'

const PUBLIC_COLUMNS = [
  'id',
  'label',
  'host',
  'port',
  'username',
  'auth_type',
  'host_key_alg',
  'host_key_sha256',
  'jump_node_id',
  'created_at',
  'updated_at',
]

function nextUpdatedAt(expectedUpdatedAt) {
  const previousMs = Date.parse(expectedUpdatedAt)
  if (!Number.isFinite(previousMs)) return null
  return new Date(Math.max(Date.now(), previousMs + 1)).toISOString()
}

export class ClusterNodesRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare(`SELECT ${PUBLIC_COLUMNS.join(', ')} FROM cluster_nodes ORDER BY created_at, id`)
    this._get = db.prepare(`SELECT ${PUBLIC_COLUMNS.join(', ')} FROM cluster_nodes WHERE id = ?`)
    this._secrets = db.prepare('SELECT password, private_key, passphrase FROM cluster_nodes WHERE id = ?')
    this._findEndpoint = db.prepare('SELECT id FROM cluster_nodes WHERE host = ? AND port = ? AND username = ?')
    this._dependents = db.prepare('SELECT id FROM cluster_nodes WHERE jump_node_id = ?')
    this._insert = db.prepare(`
      INSERT INTO cluster_nodes (id, label, host, port, username, auth_type, password, private_key, passphrase,
        host_key_alg, host_key_sha256, jump_node_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._update = db.prepare(`
      UPDATE cluster_nodes SET label = ?, host = ?, port = ?, username = ?, auth_type = ?,
        password = ?, private_key = ?, passphrase = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
      RETURNING ${PUBLIC_COLUMNS.join(', ')}
    `)
    this._updateLabel = db.prepare(`
      UPDATE cluster_nodes SET label = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
      RETURNING ${PUBLIC_COLUMNS.join(', ')}
    `)
    this._remove = db.prepare('DELETE FROM cluster_nodes WHERE id = ?')
    this._stmts = new Map()
  }

  list() {
    return this._list.all().map((row) => ({ ...row }))
  }

  get(id) {
    const row = this._get.get(id)
    return row ? { ...row } : null
  }

  findByEndpoint(host, port, username) {
    return this._findEndpoint.get(host, port, username)?.id || null
  }

  dependentsOf(id) {
    return this._dependents.all(id).map((row) => row.id)
  }

  getSecrets(id) {
    const row = this._secrets.get(id)
    if (!row) return null
    return {
      password: maybeDecrypt(row.password),
      privateKey: maybeDecrypt(row.private_key),
      passphrase: maybeDecrypt(row.passphrase),
    }
  }

  insert(node, now = new Date().toISOString()) {
    this._insert.run(
      node.id,
      node.label,
      node.host,
      node.port,
      node.username,
      node.auth_type,
      maybeEncrypt(node.password ?? null),
      maybeEncrypt(node.private_key ?? null),
      maybeEncrypt(node.passphrase ?? null),
      node.host_key_alg,
      node.host_key_sha256,
      node.jump_node_id ?? null,
      now,
      now,
    )
    return this.get(node.id)
  }

  /** Replace normalized connection fields only if the caller's version is still current. */
  update(id, node, expectedUpdatedAt) {
    const now = nextUpdatedAt(expectedUpdatedAt)
    if (!now) return null
    const row = this._update.get(
      node.label,
      node.host,
      node.port,
      node.username,
      node.auth_type,
      maybeEncrypt(node.password ?? null),
      maybeEncrypt(node.private_key ?? null),
      maybeEncrypt(node.passphrase ?? null),
      now,
      id,
      expectedUpdatedAt,
    )
    return row ? { ...row } : null
  }

  /** Rename without reading, decrypting or rewriting stored credentials. */
  updateLabel(id, label, expectedUpdatedAt) {
    const now = nextUpdatedAt(expectedUpdatedAt)
    if (!now) return null
    const row = this._updateLabel.get(label, now, id, expectedUpdatedAt)
    return row ? { ...row } : null
  }

  remove(id) {
    return this._remove.run(id).changes > 0
  }

  // Prepared on first use: callers that only load 026 (older fixtures) never touch this table.
  _stmt(sql) {
    let stmt = this._stmts.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this._stmts.set(sql, stmt)
    }
    return stmt
  }

  /** 'linux' or 'darwin'; null when the node is gone. Detected over SSH, never taken from the form. */
  platform(id) {
    return this._stmt('SELECT platform FROM cluster_nodes WHERE id = ?').get(id)?.platform ?? null
  }

  /** Not a connection edit: leaves updated_at alone so a pending node edit does not conflict. */
  setPlatform(id, platform) {
    return this._stmt('UPDATE cluster_nodes SET platform = ? WHERE id = ?').run(platform, id).changes > 0
  }

  /** node_id → { address, port }; the gate token stays out of listings. */
  directLinks() {
    const rows = this._stmt('SELECT node_id, address, port FROM cluster_node_direct_links').all()
    return new Map(rows.map((row) => [row.node_id, { address: row.address, port: row.port }]))
  }

  getDirectLink(id) {
    const row = this._stmt(
      'SELECT address, port, token, cert_sha256 FROM cluster_node_direct_links WHERE node_id = ?',
    ).get(id)
    return row
      ? { address: row.address, port: row.port, token: maybeDecrypt(row.token), certSha256: row.cert_sha256 || null }
      : null
  }

  setDirectLink(id, { address, port, token }, now = new Date().toISOString()) {
    this._stmt(`
      INSERT INTO cluster_node_direct_links (node_id, address, port, token, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET address = excluded.address, port = excluded.port,
        token = excluded.token, updated_at = excluded.updated_at
    `).run(id, address, port, maybeEncrypt(token), now)
  }

  /** The pin follows the node's gate, not the address: an address edit keeps it. */
  setDirectLinkCert(id, certSha256) {
    this._stmt('UPDATE cluster_node_direct_links SET cert_sha256 = ? WHERE node_id = ?').run(certSha256, id)
  }

  clearDirectLink(id) {
    return this._stmt('DELETE FROM cluster_node_direct_links WHERE node_id = ?').run(id).changes > 0
  }
}
