/** One line of `run/telemetry-upload.log`, written by the kin-worker sidecar. */
export type UploadEntry = {
  at: number
  kind: 'batch' | 'eval' | 'other'
  name: string
  ok: boolean
  state: string
  raw: string
}

export type UploadSummary = {
  entries: UploadEntry[]
  batch: number
  evals: number
  failed: number
  first: number | null
  last: number | null
}

const LINE_RE = /^(\S+) (\S+) (\S+) (\S+)(?: |$)/

export function parseUploadLine(raw: string): UploadEntry | null {
  const match = LINE_RE.exec(raw)
  if (!match) return null
  const at = Date.parse(match[1])
  if (!Number.isFinite(at)) return null
  const kind = match[2] === 'batch' || match[2] === 'eval' ? match[2] : 'other'
  return {
    at,
    kind,
    name: match[3] === '-' ? '' : match[3],
    ok: match[4] === 'ok',
    state: match[4],
    raw,
  }
}

export function summarizeUploads(lines: string[]): UploadSummary {
  const entries = lines
    .map(parseUploadLine)
    .filter((entry): entry is UploadEntry => entry !== null)
    .sort((a, b) => a.at - b.at)
  return {
    entries,
    batch: entries.filter((e) => e.kind === 'batch').length,
    evals: entries.filter((e) => e.kind === 'eval').length,
    failed: entries.filter((e) => !e.ok).length,
    first: entries[0]?.at ?? null,
    last: entries.length ? entries[entries.length - 1].at : null,
  }
}

export function relativeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s} 秒前`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}
