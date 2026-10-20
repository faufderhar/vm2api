/**
 * Extension-node host stats read over the existing SSH link, on the same scale
 * as the local panel host column: CPU = load1 / cores, memory = MemAvailable.
 * Remote nodes run no control-plane process, so the third figure is the sum of
 * Docker container memory (cgroup v2, minus inactive_file like `docker stats`).
 */

import { shellQuote } from './remote-fs.mjs'

export const NODE_HOST_TIMEOUT_MS = 5_000

const NODE_HOST_SCRIPT = [
  'echo "ncpu $(nproc)"',
  'echo "load $(cat /proc/loadavg)"',
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  'for d in /sys/fs/cgroup/system.slice/docker-*.scope /sys/fs/cgroup/docker/*; do',
  '  [ -r "$d/memory.current" ] || continue',
  `  echo "cg $(cat "$d/memory.current") $(awk '$1=="inactive_file"{print $2}' "$d/memory.stat" 2>/dev/null)"`,
  'done',
].join('\n')

export const NODE_HOST_COMMAND = `sh -c ${shellQuote(NODE_HOST_SCRIPT)}`

const num = (s) => {
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Returns null when the essentials (cores, load, memory) are missing. */
export function parseNodeHost(stdout) {
  let cpuCount = null
  let load = []
  let memTotal = null
  let memAvailable = null
  let containersMem = null
  for (const line of String(stdout || '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts[0] === 'ncpu') cpuCount = num(parts[1])
    else if (parts[0] === 'load') load = parts.slice(1, 4).map(num)
    else if (parts[0] === 'MemTotal:') memTotal = num(parts[1]) * 1024
    else if (parts[0] === 'MemAvailable:') memAvailable = num(parts[1]) * 1024
    else if (parts[0] === 'cg') {
      const current = num(parts[1])
      if (current == null) continue
      containersMem = (containersMem || 0) + Math.max(0, current - (num(parts[2]) || 0))
    }
  }
  const [load1, load5, load15] = load
  if (!cpuCount || load1 == null || !memTotal || memAvailable == null) return null
  const memUsed = Math.max(0, memTotal - memAvailable)
  return {
    cpu_count: cpuCount,
    load1,
    load5,
    load15,
    cpu_pct: Math.round(Math.min(1000, (load1 / cpuCount) * 1000)) / 10,
    mem_total: memTotal,
    mem_used: memUsed,
    mem_pct: Math.round((memUsed / memTotal) * 1000) / 10,
    containers_mem: containersMem,
  }
}
