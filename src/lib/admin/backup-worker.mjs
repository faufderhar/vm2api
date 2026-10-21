/**
 * Worker entry for the backup pipeline.
 *
 * The pipeline (VACUUM INTO + sha256 + tar.gz) is fully synchronous, so it must
 * not run on the gateway's main thread: that is what made auto-backups freeze
 * the whole gateway (HTTP/panel/healthz all stop answering → Cloudflare 524)
 * for the duration of the backup.
 *
 * This worker opens its own SQLite connection (WAL allows the live gateway to
 * keep serving while the snapshot is taken) and posts the finished record back
 * to BackupService. Failures are reported as a message, never thrown across the
 * thread boundary.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { openDatabase, closeDatabase } from '../db/database.mjs'
import { runBackupJob } from './backup-core.mjs'

try {
  openDatabase({ dataDir: workerData.dataDir })
  const rec = runBackupJob(workerData.ctx, workerData.job)
  parentPort.postMessage({ ok: true, rec })
} catch (e) {
  parentPort.postMessage({
    ok: false,
    error: { message: String((e && e.message) || e), code: (e && e.code) || null },
  })
} finally {
  try {
    closeDatabase()
  } catch {}
}
