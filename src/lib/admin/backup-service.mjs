/**
 * Local backup service — sub2api BackupService counterpart (no S3, per user).
 *
 * Backup artifact: data/backups/kin-backup-<stamp>.tar.gz (0600) containing
 *   manifest.json   {version, created_at, kind, includes, sha256s}
 *   db/kin.db       VACUUM INTO online-consistent snapshot (credentials
 *                   already mirrored into the `vms` table)
 *   vms/            slot *.json + active.json (double safety)
 *   config/         routing.json / intercept-rules.json …
 *
 * When `tar` is unavailable the service degrades to a gzipped DB snapshot
 * (kin-backup-<stamp>.db.gz) — still fully restorable because the DB holds
 * the credential mirror (vm files are rebuilt from vms.vm_json). That fallback
 * buffers the whole snapshot in memory, so it only works below ~2 GiB; the
 * tar path has no such limit.
 *
 * Staging lives on the data volume (`<dataDir>/tmp`, override with
 * KIN_BACKUP_TMPDIR), not os.tmpdir(): /tmp is a tmpfs sized to a fraction of
 * RAM and a multi-GB `VACUUM INTO` snapshot fails there with SQLITE_FULL
 * ("database or disk is full") while the real disk still has room.
 *
 * Scheduling (default ON, user requirement):
 *   settings.backup_schedule = { enabled: true, interval_hours: 24, retention: 7 }
 *   env overrides: KIN_BACKUP_DISABLED=1, KIN_BACKUP_INTERVAL_HOURS, KIN_BACKUP_RETENTION
 *   - checker runs every 10 min + a catch-up check shortly after boot
 *   - the job itself runs in a worker thread (backup-worker.mjs): the
 *     pipeline is synchronous for minutes, so running it in-process
 *     would stop the gateway from answering (Cloudflare 524)
 *   - retention prunes old ok backups (pre_restore keeps newest 3)
 *
 * Restore:
 *   verify manifest/sha256 → automatic pre_restore backup → copy the snapshot
 *   beside kin.db and quick_check it → atomic rename (old file kept as
 *   kin.db.pre-restore) → restore vms/ + config/ (or rebuild from DB) →
 *   reopen + migrate → rebind stores. Any failure after the swap rolls the
 *   database back, puts vms/ and config/ back, reopens the previous database,
 *   and rebinds stores.
 *   `isRestoring` flag lets the server 503 protocol traffic meanwhile.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { getDb, getDbPath, closeDatabase, openDatabase } from '../db/database.mjs'
import { sha256File } from './backup-core.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { BackupRepo } from '../db/repos/backup-repo.mjs'
import { reconcileVms } from '../vm/vm-db-sync.mjs'
import { repairSlotSmbios, repairVmProxyCliEnabled } from '../vm/vm-registry.mjs'
import { invalidateReadCache, isVmRecordFile } from '../vm/vm-file.mjs'

// tarAvailability / sha256File / the runnable pipeline live in backup-core.mjs;
// keep the historical export surface for tests and callers.
export { tarAvailable } from './backup-core.mjs'

function discardSqliteSidecars(file) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(file + suffix, { force: true })
    } catch {}
  }
}

function assertRestorableSqlite(file) {
  let db
  try {
    db = new DatabaseSync(file)
    const row = db.prepare('PRAGMA quick_check').get()
    const value = row && (row.quick_check || Object.values(row)[0])
    if (value !== 'ok') {
      throw Object.assign(new Error('restored database failed integrity check'), { code: 'backup_corrupt' })
    }
  } catch (error) {
    if (error?.code === 'backup_corrupt') throw error
    throw Object.assign(new Error('restored database is not a readable sqlite file'), {
      code: 'backup_corrupt',
    })
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile()
  } catch {
    return false
  }
}

function copyFiles(srcDir, destDir, accept) {
  if (!srcDir || !fs.existsSync(srcDir)) return
  fs.mkdirSync(destDir, { recursive: true })
  for (const name of fs.readdirSync(srcDir)) {
    if (accept && !accept(name)) continue
    const from = path.join(srcDir, name)
    if (!isRegularFile(from)) continue
    fs.copyFileSync(from, path.join(destDir, name))
  }
}

function snapshotSlotFiles({ projectRoot, configDir, destRoot }) {
  const snap = {
    vmsLive: projectRoot ? path.join(projectRoot, 'vms') : null,
    vmsSnap: path.join(destRoot, 'rollback-vms'),
    configLive: configDir || null,
    configSnap: path.join(destRoot, 'rollback-config'),
    configArchive: [],
  }
  copyFiles(snap.vmsLive, snap.vmsSnap, (name) => isVmRecordFile(name) || name === 'active.json')
  copyFiles(snap.configLive, snap.configSnap, () => true)
  return snap
}

function restoreSlotFiles(snap) {
  if (!snap) return
  if (snap.vmsLive) {
    fs.mkdirSync(snap.vmsLive, { recursive: true })
    if (fs.existsSync(snap.vmsLive)) {
      for (const name of fs.readdirSync(snap.vmsLive)) {
        if (!(isVmRecordFile(name) || name === 'active.json')) continue
        try {
          fs.rmSync(path.join(snap.vmsLive, name), { force: true })
        } catch {}
      }
    }
    copyFiles(snap.vmsSnap, snap.vmsLive, () => true)
  }
  if (!snap.configLive) return
  fs.mkdirSync(snap.configLive, { recursive: true })
  const kept = new Set(fs.existsSync(snap.configSnap) ? fs.readdirSync(snap.configSnap) : [])
  for (const name of snap.configArchive || []) {
    if (kept.has(name)) continue
    try {
      fs.rmSync(path.join(snap.configLive, name), { force: true })
    } catch {}
  }
  copyFiles(snap.configSnap, snap.configLive, () => true)
}

const SCHEDULE_KEY = 'backup_schedule'

export const DEFAULT_SCHEDULE = {
  enabled: true,
  interval_hours: 24,
  retention: 7,
}

export class BackupService {
  constructor({ dataDir, projectRoot, configDir, backupDir, tmpDir, checkIntervalMs = 10 * 60_000 } = {}) {
    this.dataDir = dataDir
    this.projectRoot = projectRoot
    this.configDir = configDir || null
    this.backupDir = backupDir || path.join(dataDir, 'backups')
    this.tmpDir = tmpDir || path.join(dataDir, 'tmp')
    this.checkIntervalMs = checkIntervalMs
    this.isRestoring = false
    this._running = false
    this._timer = null
    this._bootTimer = null
    this._rebindStores = null // set via onRestored()
  }

  _repo() {
    return new BackupRepo(getDb())
  }
  _settings() {
    return new SettingsRepo(getDb())
  }

  /** Staging dir on the data volume — the DB snapshot can be several GB. */
  _mkdtemp(prefix) {
    const base = process.env.KIN_BACKUP_TMPDIR || this.tmpDir
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(base, 0o700)
    } catch {}
    return fs.mkdtempSync(path.join(base, prefix))
  }

  /** Register the callback that re-binds stores to the new DB after restore. */
  onRestored(fn) {
    this._rebindStores = typeof fn === 'function' ? fn : null
  }

  // ---------- schedule config ----------

  getSchedule() {
    let cfg = { ...DEFAULT_SCHEDULE, ...(this._settings().get(SCHEDULE_KEY, {}) || {}) }
    if (process.env.KIN_BACKUP_DISABLED === '1') cfg.enabled = false
    if (process.env.KIN_BACKUP_INTERVAL_HOURS) {
      const n = Number(process.env.KIN_BACKUP_INTERVAL_HOURS)
      if (Number.isFinite(n) && n > 0) cfg.interval_hours = n
    }
    if (process.env.KIN_BACKUP_RETENTION) {
      const n = Number(process.env.KIN_BACKUP_RETENTION)
      if (Number.isFinite(n) && n > 0) cfg.retention = n
    }
    return cfg
  }

  updateSchedule(patch = {}) {
    const cur = { ...DEFAULT_SCHEDULE, ...(this._settings().get(SCHEDULE_KEY, {}) || {}) }
    if (patch.enabled != null) cur.enabled = !!patch.enabled
    if (patch.interval_hours != null) {
      const n = Number(patch.interval_hours)
      if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
        throw Object.assign(new Error('interval_hours must be 1..720'), { code: 'invalid_interval' })
      }
      cur.interval_hours = n
    }
    if (patch.retention != null) {
      const n = Math.floor(Number(patch.retention))
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        throw Object.assign(new Error('retention must be 1..100'), { code: 'invalid_retention' })
      }
      cur.retention = n
    }
    this._settings().set(SCHEDULE_KEY, cur)
    return this.getSchedule()
  }

  nextAutoAt() {
    const cfg = this.getSchedule()
    if (!cfg.enabled) return null
    const last = this._repo().lastSuccessful({})
    const base = last ? Date.parse(last.created_at) : 0
    return new Date(Math.max(Date.now(), base + cfg.interval_hours * 3600_000)).toISOString()
  }

  // ---------- create ----------

  /**
   * Run one backup off the main thread.
   *
   * The pipeline (VACUUM INTO + sha256 + tar.gz) is synchronous for minutes on a
   * multi-GB database, so it runs in a worker with its own DB connection while
   * the gateway keeps serving requests.
   *
   * @returns {Promise<backup record>}
   */
  async createBackup({ kind = 'manual', note = null } = {}) {
    if (this._running) throw Object.assign(new Error('backup already in progress'), { code: 'backup_in_progress' })
    this._running = true
    const id = 'bak_' + crypto.randomBytes(6).toString('hex')
    const createdAt = new Date().toISOString()
    try {
      return await this._runBackupWorker({
        id,
        createdAt,
        kind,
        note,
        retention: this.getSchedule().retention,
      })
    } catch (e) {
      // The worker records its own failure; this covers the cases where it never
      // got that far (module error, OOM, kill) so the panel still shows the job.
      try {
        if (!this._repo().get(id)) {
          this._repo().insert({
            id,
            created_at: createdAt,
            kind,
            status: 'failed',
            file_path: null,
            file_name: null,
            size_bytes: null,
            sha256: null,
            db_bytes: null,
            includes: null,
            error: String(e.message || e).slice(0, 500),
            note,
          })
        }
      } catch {}
      throw e
    } finally {
      this._running = false
    }
  }

  _runBackupWorker(job) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
        workerData: {
          dataDir: this.dataDir,
          ctx: {
            projectRoot: this.projectRoot,
            configDir: this.configDir,
            backupDir: this.backupDir,
            tmpDir: this.tmpDir,
          },
          job,
        },
      })
      let settled = false
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        fn(arg)
      }
      worker.once('message', (msg) => {
        if (msg && msg.ok) return finish(resolve, msg.rec)
        finish(
          reject,
          Object.assign(new Error((msg && msg.error && msg.error.message) || 'backup failed'), {
            code: (msg && msg.error && msg.error.code) || 'backup_failed',
          }),
        )
      })
      worker.once('error', (e) => finish(reject, e))
      worker.once('exit', (code) => {
        if (code !== 0) finish(reject, new Error(`backup worker exited with code ${code}`))
      })
    })
  }

  // ---------- list / delete ----------

  list({ limit = 100 } = {}) {
    return this._repo()
      .list({ limit })
      .map((r) => ({
        ...r,
        file_exists: !!(r.file_path && fs.existsSync(r.file_path)),
      }))
  }

  get(id) {
    return this._repo().get(id)
  }

  remove(id) {
    const rec = this._repo().get(id)
    if (!rec) return false
    try {
      if (rec.file_path && fs.existsSync(rec.file_path)) fs.rmSync(rec.file_path, { force: true })
    } catch {}
    return this._repo().remove(id)
  }

  // ---------- restore ----------

  /**
   * Restore from a recorded backup. Automatically snapshots the current
   * state first (kind=pre_restore). Re-binds stores via onRestored callback.
   */
  async restoreBackup(id) {
    const rec = this._repo().get(id)
    if (!rec) throw Object.assign(new Error('backup not found'), { code: 'backup_not_found' })
    if (rec.status !== 'ok')
      throw Object.assign(new Error('backup record is not restorable'), { code: 'backup_not_ok' })
    if (!rec.file_path || !fs.existsSync(rec.file_path)) {
      throw Object.assign(new Error('backup file missing on disk'), { code: 'backup_file_missing' })
    }
    if (this.isRestoring) throw Object.assign(new Error('restore already in progress'), { code: 'restore_in_progress' })

    // integrity: archive checksum must match the record
    const actual = sha256File(rec.file_path)
    if (rec.sha256 && actual !== rec.sha256) {
      throw Object.assign(new Error('backup archive sha256 mismatch'), { code: 'backup_corrupt' })
    }

    this.isRestoring = true
    let tmp = null
    let swapped = false
    let dbPath = null
    let fileSnap = null
    const keepName = () => `${dbPath}.pre-restore`
    const stageName = () => `${dbPath}.restore-next`
    try {
      // 0. safety net snapshot of the current state
      const pre = await this.createBackup({ kind: 'pre_restore', note: `before restore of ${rec.id}` })

      // 1. extract / decompress
      tmp = this._mkdtemp('kin-restore-')
      let dbFile
      let manifest = null
      if (rec.file_name?.endsWith('.tar.gz')) {
        const r = spawnSync('tar', ['-xzf', rec.file_path, '-C', tmp], { stdio: 'pipe' })
        if (r.status !== 0) throw new Error(`tar extract failed: ${String(r.stderr || '').slice(0, 300)}`)
        dbFile = path.join(tmp, 'db', 'kin.db')
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
        } catch {}
        if (manifest?.sha256s?.['db/kin.db']) {
          if (sha256File(dbFile) !== manifest.sha256s['db/kin.db']) {
            throw Object.assign(new Error('db snapshot sha256 mismatch inside archive'), { code: 'backup_corrupt' })
          }
        }
      } else {
        dbFile = path.join(tmp, 'kin.db')
        fs.writeFileSync(dbFile, zlib.gunzipSync(fs.readFileSync(rec.file_path)))
      }
      if (!fs.existsSync(dbFile)) throw new Error('no db snapshot inside backup')

      // 2. stage and check the new database before the live file moves
      dbPath = getDbPath()
      if (!dbPath) throw new Error('database path is not open')
      fs.copyFileSync(dbFile, stageName())
      try {
        fs.chmodSync(stageName(), 0o600)
      } catch {}
      assertRestorableSqlite(stageName())
      closeDatabase()
      const keep = keepName()
      try {
        fs.rmSync(keep, { force: true })
        fs.renameSync(dbPath, keep)
        swapped = true
        discardSqliteSidecars(dbPath)
        fs.renameSync(stageName(), dbPath)
      } catch (error) {
        if (swapped && fs.existsSync(keep)) {
          try {
            fs.rmSync(dbPath, { force: true })
          } catch {}
          try {
            fs.renameSync(keep, dbPath)
          } catch {}
        }
        swapped = false
        try {
          const restored = openDatabase({ dataDir: this.dataDir, dbPath })
          try {
            this._rebindStores?.(restored)
          } catch {}
        } catch {}
        throw error
      }

      // 3. restore vm + config files from the archive (tar flavor only).
      // Snapshot the live files first so a later failure can put them back.
      fileSnap = snapshotSlotFiles({ projectRoot: this.projectRoot, configDir: this.configDir, destRoot: tmp })
      const vmsDirSrc = path.join(tmp, 'vms')
      if (this.projectRoot && fs.existsSync(vmsDirSrc)) {
        const vmsDir = path.join(this.projectRoot, 'vms')
        fs.mkdirSync(vmsDir, { recursive: true })
        // replace vm json records with archive state (cli-home dirs untouched)
        for (const f of fs.readdirSync(vmsDir)) {
          if (isVmRecordFile(f) || f === 'active.json') {
            try {
              fs.rmSync(path.join(vmsDir, f), { force: true })
            } catch {}
          }
        }
        for (const f of fs.readdirSync(vmsDirSrc)) {
          fs.copyFileSync(path.join(vmsDirSrc, f), path.join(vmsDir, f))
          try {
            fs.chmodSync(path.join(vmsDir, f), 0o600)
          } catch {}
        }
      }
      const cfgDirSrc = path.join(tmp, 'config')
      if (this.configDir && fs.existsSync(cfgDirSrc)) {
        fileSnap.configArchive = fs.readdirSync(cfgDirSrc).filter((name) => isRegularFile(path.join(cfgDirSrc, name)))
        fs.mkdirSync(this.configDir, { recursive: true })
        for (const f of fs.readdirSync(cfgDirSrc)) {
          fs.copyFileSync(path.join(cfgDirSrc, f), path.join(this.configDir, f))
        }
      }

      // 4. reopen + migrate (old backups upgrade automatically)
      const db = openDatabase({ dataDir: this.dataDir, dbPath })

      // 5. db-only backups: rebuild vm files from the credential mirror
      if (this.projectRoot) {
        invalidateReadCache()
        try {
          reconcileVms(this.projectRoot)
          try {
            repairVmProxyCliEnabled(this.projectRoot)
          } catch {}
          try {
            repairSlotSmbios(this.projectRoot)
          } catch {}
        } catch {}
      }

      // 6. the ledger itself rolled back with the DB — re-register the
      //    pre_restore snapshot (and any other on-disk archives) so the
      //    user can still see/undo from the panel.
      try {
        this._registerOrphanArchives([pre, rec])
      } catch {}

      // 7. re-bind stores to the fresh connection. A failed rebind leaves the
      //    process partially attached to the closed database, so it must make
      //    the restore fail instead of reporting a false success.
      if (this._rebindStores) this._rebindStores(db)

      return { ok: true, restored: rec.id, pre_restore: pre.id }
    } catch (error) {
      if (fileSnap) {
        try {
          restoreSlotFiles(fileSnap)
        } catch {}
      }
      if (swapped && dbPath) this._rollbackRestore(dbPath)
      throw error
    } finally {
      this.isRestoring = false
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true })
        } catch {}
      }
      if (dbPath) {
        try {
          fs.rmSync(stageName(), { force: true })
        } catch {}
      }
    }
  }

  _rollbackRestore(file) {
    const keep = `${file}.pre-restore`
    try {
      closeDatabase()
    } catch {}
    discardSqliteSidecars(file)
    if (fs.existsSync(keep)) {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
      fs.renameSync(keep, file)
    }
    discardSqliteSidecars(file)
    const db = openDatabase({ dataDir: this.dataDir, dbPath: file })
    try {
      this._rebindStores?.(db)
    } catch {}
  }

  /**
   * Insert ledger rows for archive files that exist on disk but have no
   * record in the (freshly restored) DB. `known` records are inserted
   * verbatim; remaining orphans get kind='imported'.
   */
  _registerOrphanArchives(known = []) {
    const repo = this._repo()
    const existing = new Set(repo.list({ limit: 500 }).map((r) => r.file_name))
    for (const rec of known) {
      if (rec?.file_name && !existing.has(rec.file_name) && rec.file_path && fs.existsSync(rec.file_path)) {
        try {
          repo.insert(rec)
          existing.add(rec.file_name)
        } catch {}
      }
    }
    if (!fs.existsSync(this.backupDir)) return
    for (const f of fs.readdirSync(this.backupDir)) {
      if (!/^kin-backup-.*\.(tar\.gz|db\.gz)$/.test(f) || existing.has(f)) continue
      const fp = path.join(this.backupDir, f)
      try {
        const st = fs.statSync(fp)
        repo.insert({
          id: 'bak_' + crypto.randomBytes(6).toString('hex'),
          created_at: st.mtime.toISOString(),
          kind: 'imported',
          status: 'ok',
          file_path: fp,
          file_name: f,
          size_bytes: st.size,
          sha256: sha256File(fp),
          db_bytes: null,
          includes: null,
          error: null,
          note: 're-registered from disk after restore',
        })
        existing.add(f)
      } catch {}
    }
  }

  // ---------- scheduler ----------

  /** Auto-backup checker: every checkIntervalMs + a catch-up run at boot. */
  startScheduler() {
    this.stopScheduler()
    const check = async () => {
      try {
        if (this.shouldRunScheduled()) {
          const rec = await this.createBackup({ kind: 'scheduled' })
          console.log(`[backup] scheduled backup completed (${Math.round((rec.size_bytes || 0) / 1048576)} MiB)`)
        }
      } catch (e) {
        console.warn('[backup] scheduled backup failed:', String(e.message || e))
      }
    }
    this._timer = setInterval(check, this.checkIntervalMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
    // boot catch-up (delayed so startup isn't blocked)
    this._bootTimer = setTimeout(check, 5_000)
    if (typeof this._bootTimer.unref === 'function') this._bootTimer.unref()
  }

  shouldRunScheduled(now = Date.now()) {
    const cfg = this.getSchedule()
    if (!cfg.enabled || this._running || this.isRestoring) return false
    const last = this._repo().lastSuccessful({})
    if (!last) return true
    return now - Date.parse(last.created_at) >= cfg.interval_hours * 3600_000
  }

  stopScheduler() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._bootTimer) {
      clearTimeout(this._bootTimer)
      this._bootTimer = null
    }
  }
}
