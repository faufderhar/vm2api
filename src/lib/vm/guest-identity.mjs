/**
 * Merge guest-collected facts into vm.json fingerprint.
 * device_id / session_id / generated hostname / catalog kernel
 * are never rotated here (reset-fingerprint owns that).
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './vm-file.mjs'
import { runtimeKind, isKvmRuntime } from './runtime-kind.mjs'
import { slotExec } from './slot-runtime.mjs'
import { readGuestIdentity, normalizeGuestHardware } from './guest-identity-reader.mjs'
import { OFFICIAL_STAINLESS } from '../identity/vm-identity.mjs'
import { applyOfficialFingerprintToVm } from '../identity/official-fingerprint.mjs'
import { isHostKernel } from '../identity/workstation-profile.mjs'
import { syncWorkerTelemetry } from './vm-runtime.mjs'
import { slotHost } from './slot-host.mjs'
import { isGeneratedHostname } from '../identity/workstation-fingerprint.mjs'
import { isCodexVm, isGrokVm } from './vm-kind.mjs'
import { slotExecContainer } from './slot-exec.mjs'
import { inspectContainerOrNull } from '../cluster/docker-remote.mjs'

export const GUEST_IDENTITY_SCHEMA = '1'

const DMI_KEYS = Object.freeze(['manufacturer', 'product', 'version', 'family', 'serial', 'uuid'])

function textOrNull(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text ? text : null
}

function intOrNull(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

function pickText(next, prev) {
  return textOrNull(next) ?? textOrNull(prev)
}

function pickInt(next, prev) {
  return intOrNull(next) ?? intOrNull(prev)
}

/** Merge observed hardware; empty new facts keep previous values. */
export function mergeGuestHardware(prev, next, observedAt) {
  const p = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
  const n = next && typeof next === 'object' && !Array.isArray(next) ? next : {}
  const pd = p.dmi && typeof p.dmi === 'object' ? p.dmi : {}
  const nd = n.dmi && typeof n.dmi === 'object' ? n.dmi : {}
  const dmi = {}
  for (const key of DMI_KEYS) {
    dmi[key] = pickText(nd[key], pd[key])
  }
  return {
    cpu_model: pickText(n.cpu_model, p.cpu_model),
    cpu_cores: pickInt(n.cpu_cores, p.cpu_cores),
    memory_bytes: pickInt(n.memory_bytes, p.memory_bytes),
    root_disk: pickText(n.root_disk, p.root_disk),
    mac: pickText(n.mac, p.mac),
    dmi,
    shell: pickText(n.shell, p.shell),
    package_managers: pickText(n.package_managers, p.package_managers),
    runtimes: pickText(n.runtimes, p.runtimes),
    observed_at: pickText(n.observed_at, observedAt) || textOrNull(p.observed_at),
  }
}

function stainlessArch(arch) {
  const a = String(arch || '').toLowerCase()
  if (a === 'amd64' || a === 'x86_64' || a === 'x64') return 'x64'
  if (a === 'arm64' || a === 'aarch64') return 'arm64'
  return a || 'x64'
}

function stainlessOs(goos) {
  const o = String(goos || '').toLowerCase()
  if (o === 'darwin') return 'MacOS'
  if (o === 'windows') return 'Windows'
  return 'Linux'
}

export function mergeGuestFingerprint(prev = {}, guest = {}) {
  const officialMachine = prev.official_machine_id || null
  const deviceId = officialMachine || prev.device_id || guest.device_id || ''
  const sessionId = prev.session_id || guest.session_id || ''
  const arch = stainlessArch(guest.arch || prev.stainless_arch)
  const os = stainlessOs(guest.goos || guest.os || prev.stainless_os)
  const keepHost = isGeneratedHostname(prev.hostname)
  const hostname = keepHost ? prev.hostname : guest.hostname || prev.hostname || null
  const guestHostname = guest.hostname && guest.hostname !== hostname ? guest.hostname : prev.guest_hostname || null
  const hostLeak = isHostKernel(guest.kernel_release)
  const outboundKernel =
    prev.linux_kernel ||
    (!hostLeak && guest.kernel_release) ||
    (!isHostKernel(prev.kernel_release) && prev.kernel_release) ||
    guest.kernel_release ||
    prev.kernel_release ||
    null
  const guestKernel =
    guest.kernel_release && guest.kernel_release !== outboundKernel
      ? guest.kernel_release
      : prev.guest_kernel_release || null
  const guestMachine = prev.guest_machine_id
    ? prev.guest_machine_id
    : guest.machine_id || (prev.machine_id && prev.machine_id !== officialMachine ? prev.machine_id : null)
  const next = {
    ...prev,
    device_id: deviceId,
    session_id: sessionId,
    source: prev.source === 'generated' ? 'generated' : 'guest',
    schema_version: guest.schema_version || GUEST_IDENTITY_SCHEMA,
    runtime_kind: guest.runtime_kind || prev.runtime_kind || null,
    hostname,
    guest_hostname: guestHostname,
    os_id: guest.os_id || prev.os_id || null,
    os_pretty: guest.os_pretty || prev.os_pretty || null,
    kernel_release: outboundKernel,
    linux_kernel: prev.linux_kernel || null,
    guest_kernel_release: guestKernel,
    official_machine_id: officialMachine || prev.official_machine_id || null,
    official_user_id: prev.official_user_id || null,
    identity_source: officialMachine ? 'official-cc-init' : prev.identity_source || null,
    guest_machine_id: guestMachine || prev.guest_machine_id || null,
    timezone: prev.timezone || guest.timezone || null,
    locale: prev.locale || guest.locale || null,
    worker_version: guest.worker_version || prev.worker_version || null,
    collected_at: guest.collected_at || new Date().toISOString(),
    user_agent: prev.user_agent || null,
    x_app: prev.x_app || 'cli',
    stainless_lang: OFFICIAL_STAINLESS.stainless_lang,
    stainless_os: os,
    stainless_arch: arch,
    stainless_runtime: OFFICIAL_STAINLESS.stainless_runtime,
    stainless_runtime_version: OFFICIAL_STAINLESS.stainless_runtime_version,
    stainless_package_version: OFFICIAL_STAINLESS.stainless_package_version,
    reset_at: prev.reset_at || null,
    updated_at: new Date().toISOString(),
  }
  const guestHw = guest.hardware != null ? normalizeGuestHardware(guest.hardware) : null
  if (guestHw) {
    next.hardware = mergeGuestHardware(
      prev.hardware,
      { ...guestHw, observed_at: guest.hardware?.observed_at },
      guest.collected_at,
    )
  }
  if (officialMachine) delete next.machine_id
  return next
}

/** Container state for a collect precheck: {exists, running, status}. */
export async function inspectCollectTarget(vm) {
  const host = slotHost(vm)
  if (typeof host.inspect === 'function') return host.inspect(vm)
  const info = await inspectContainerOrNull(host.dockerApi(), slotExecContainer(vm))
  if (!info) return { exists: false, running: false, status: null }
  const state = info.State || {}
  return {
    exists: true,
    running: state.Running === true && state.Restarting !== true,
    status: state.Status || null,
  }
}

function inferenceNote(vm) {
  if (isGrokVm(vm)) return 'Grok 槽推理不依赖容器，服务不受影响'
  if (isCodexVm(vm)) return 'GPT 槽推理由主机 Codex 内核负责，服务不受影响'
  return '该槽推理需要容器，请尽快开机'
}

const COLLECT_STATUS = Object.freeze({
  slot_container_missing: 409,
  slot_container_stopped: 409,
  docker_unavailable: 503,
  guest_identity_timeout: 504,
})

/**
 * Chinese, operator-facing reason for a failed collect. Docker's raw stderr
 * ("No such container: kin-x") is mapped to a code; unknown text is kept as a tail.
 */
export function describeCollectFailure(vm, { code, raw = '', state = null, timeoutMs = 0 } = {}) {
  const text = String(raw || '').trim()
  const container = slotExecContainer(vm)
  let c = code || 'worker_identity_failed'
  if (/no such container/i.test(text)) c = 'slot_container_missing'
  else if (/is not running|is restarting|is paused/i.test(text)) c = 'slot_container_stopped'
  else if (
    /cannot connect to the docker daemon|docker\.sock|ECONNREFUSED|ENOENT.*docker|docker: (command )?not found|spawn docker ENOENT/i.test(
      text,
    )
  ) {
    c = 'docker_unavailable'
  } else if (/executable file not found|exec: "sh"|sh: not found/i.test(text)) c = 'guest_shell_missing'
  let message
  switch (c) {
    case 'slot_container_missing':
      message = `该槽没有运行中的容器（${container || '未命名'} 不存在；${inferenceNote(vm)}），请先开机再采集`
      break
    case 'slot_container_stopped':
      message = `该槽容器未运行（${container}${state?.status ? `，状态 ${state.status}` : ''}；${inferenceNote(vm)}），请先开机再采集`
      break
    case 'docker_unavailable':
      message = `无法连接 Docker，采集未执行：${text.slice(0, 160) || '未知错误'}`
      break
    case 'guest_shell_missing':
      message = '容器里没有可用的 sh，无法读取系统信息'
      break
    case 'guest_identity_timeout':
      message = `采集超时（${Math.round((timeoutMs || 0) / 1000) || '?'} 秒），容器可能卡住或负载过高，请稍后重试`
      break
    case 'guest_identity_invalid':
      message = '容器返回的系统信息不完整（缺少主机名、内核或架构），请检查镜像'
      break
    case 'vm_json_unreadable':
      message = '槽记录 vm.json 读取失败，采集结果未保存'
      break
    case 'worker_identity_unsupported':
      message = '该槽的内核不支持读取系统信息'
      break
    default:
      message = `采集失败：${text.slice(0, 200) || '未知错误'}`
  }
  return { code: c, message, status: COLLECT_STATUS[c] || 502 }
}

function readVmJson(vmPath) {
  try {
    return JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  } catch {
    return null
  }
}

/** Persist the last collect failure on the slot record; never throws. */
function recordCollectFailure(vmPath, failure, at) {
  const current = readVmJson(vmPath)
  if (!current) return
  current.runtime = {
    ...(current.runtime || {}),
    identity_collect_error: { code: failure.code, message: failure.message, at },
  }
  try {
    atomicWriteJson(vmPath, current, { mode: 0o600 })
  } catch {}
}

/**
 * `inspect` prechecks the container before `docker exec`. It defaults to the
 * Docker API only alongside the real reader; an injected `callGet` (tests,
 * fleet tools) skips it unless `inspect` is passed too.
 */
export async function collectSlotIdentity(
  projectRoot,
  vm,
  { callGet = readGuestIdentity, timeoutMs, inspect, now = () => new Date() } = {},
) {
  if (!vm?.id) return { ok: false, error: 'vm required' }
  const exec = slotExec(projectRoot, vm)
  const ms = timeoutMs ?? (isKvmRuntime(vm) ? 20_000 : 5_000)
  const precheck = inspect === undefined ? (callGet === readGuestIdentity ? inspectCollectTarget : null) : inspect
  const fail = (info) => {
    const failure = describeCollectFailure(vm, { ...info, timeoutMs: ms })
    recordCollectFailure(exec.vmPath, failure, now().toISOString())
    return { ok: false, id: vm.id, error: failure.message, code: failure.code, status: failure.status }
  }
  if (precheck) {
    let state = null
    try {
      state = await precheck(vm)
    } catch {
      state = null // inspect itself failing is not proof of anything: let exec report the real error
    }
    if (state && state.exists === false) return fail({ code: 'slot_container_missing', state })
    if (state && state.exists && state.running === false) return fail({ code: 'slot_container_stopped', state })
  }
  const res = await callGet(exec, '/internal/identity', { timeoutMs: ms })
  if (!res?.ok) {
    const message = res?.body?.error?.message || res?.body?.error || `identity status ${res?.status || 0}`
    return fail({
      code: res?.status === 404 ? 'worker_identity_unsupported' : res?.body?.error?.code || 'worker_identity_failed',
      raw: String(message),
    })
  }
  const guest = res.body?.identity && typeof res.body.identity === 'object' ? res.body.identity : res.body
  const vmPath = exec.vmPath
  let current = readVmJson(vmPath)
  if (!current) return fail({ code: 'vm_json_unreadable' })
  if (!guest.runtime_kind) guest.runtime_kind = runtimeKind(current)
  current.fingerprint = mergeGuestFingerprint(current.fingerprint, guest)
  current.runtime = {
    ...(current.runtime || {}),
    type: runtimeKind(current),
    guest_hostname: current.fingerprint.guest_hostname || current.fingerprint.hostname,
    guest_os: current.fingerprint.os_pretty,
    guest_kernel: current.fingerprint.guest_kernel_release || current.fingerprint.kernel_release,
    identity_collected_at: current.fingerprint.collected_at,
  }
  delete current.runtime.identity_collect_error
  current.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, current, { mode: 0o600 })
  // Grok has no Claude Code home or telemetry sidecar config: guest facts only.
  if (isGrokVm(current)) {
    return { ok: true, id: vm.id, fingerprint: current.fingerprint, runtime_kind: current.runtime.type }
  }
  const homeDir = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  applyOfficialFingerprintToVm(vmPath, homeDir)
  try {
    current = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  } catch {}
  try {
    const telemetry = syncWorkerTelemetry(current, projectRoot)
    if (telemetry.wrote) {
      await slotHost(current).syncRun(current, path.join(projectRoot, 'vms', current.id))
    }
    return {
      ok: true,
      id: vm.id,
      fingerprint: current.fingerprint,
      runtime_kind: current.runtime.type,
      telemetry_sync: telemetry,
    }
  } catch (error) {
    return {
      ok: false,
      id: vm.id,
      fingerprint: current.fingerprint,
      runtime_kind: current.runtime.type,
      error: `telemetry sync failed: ${String(error?.message || error).slice(0, 300)}`,
      code: 'telemetry_sync_failed',
    }
  }
}

const inflightCollects = new Map()
const pendingAutoCollects = new Set()

/** One collect per slot at a time: a second caller joins the running one. */
export function collectSlotIdentityOnce(projectRoot, vm, opts = {}) {
  const id = vm?.id
  if (!id) return collectSlotIdentity(projectRoot, vm, opts)
  const running = inflightCollects.get(id)
  if (running) return running
  const job = Promise.resolve()
    .then(() => collectSlotIdentity(projectRoot, vm, opts))
    .finally(() => inflightCollects.delete(id))
  inflightCollects.set(id, job)
  return job
}

export function identityCollectInFlight(vmId) {
  return inflightCollects.has(vmId)
}

function everCollected(vm) {
  const fp = vm?.fingerprint || {}
  return !!(fp.hardware?.observed_at || fp.collected_at || vm?.runtime?.identity_collected_at)
}

/**
 * After a successful start: one background collect for a docker slot that was
 * never collected. Never blocks or fails the start; failures land on the record
 * via collectSlotIdentity. KVM guests boot too slowly for an immediate collect.
 */
export function scheduleIdentityAutoCollect(
  projectRoot,
  vmId,
  { getVm, collect = collectSlotIdentityOnce, delayMs = 1500, setTimer = setTimeout } = {},
) {
  const load = () => {
    try {
      return getVm
        ? getVm(projectRoot, vmId)
        : /^[\w.-]+$/.test(String(vmId)) && !String(vmId).startsWith('.')
          ? readVmJson(path.join(projectRoot, 'vms', `${vmId}.json`))
          : null
    } catch {
      return null
    }
  }
  const vm = load()
  if (!vm?.id) return { scheduled: false, reason: 'vm_missing' }
  if (isKvmRuntime(vm)) return { scheduled: false, reason: 'kvm' }
  if (everCollected(vm)) return { scheduled: false, reason: 'already_collected' }
  if (inflightCollects.has(vm.id) || pendingAutoCollects.has(vm.id)) return { scheduled: false, reason: 'in_flight' }
  pendingAutoCollects.add(vm.id)
  const run = () => {
    pendingAutoCollects.delete(vm.id)
    const fresh = load()
    if (!fresh?.id || everCollected(fresh)) return
    Promise.resolve()
      .then(() => collect(projectRoot, fresh))
      .catch(() => {})
  }
  if (delayMs > 0) {
    const t = setTimer(run, delayMs)
    t?.unref?.()
  } else run()
  return { scheduled: true }
}
