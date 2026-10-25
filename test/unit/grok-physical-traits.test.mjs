import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectSlotIdentity,
  collectSlotIdentityOnce,
  describeCollectFailure,
  scheduleIdentityAutoCollect,
} from '../../src/lib/vm/guest-identity.mjs'
import { readSlotIdentityProfile, parseSmbiosType1 } from '../../src/lib/identity/slot-identity-profile.mjs'
import { publicPhysicalFeatures } from '../../src/lib/admin/panel-api.mjs'
import { diagnoseSlotServices } from '../../src/lib/vm/slot-recovery.mjs'

const GROK = { platform: 'xai', family: 'grok', runtime: { type: 'docker' } }
const GUEST = {
  ok: true,
  status: 200,
  body: {
    identity: {
      hostname: 'imac15-1-ab',
      os_id: 'ubuntu',
      os_pretty: 'Ubuntu 24.04',
      kernel_release: '6.8.0',
      arch: 'amd64',
      collected_at: '2026-10-25T00:00:00.000Z',
      hardware: { cpu_model: 'Intel Core i7', cpu_cores: 4, observed_at: '2026-10-25T00:00:00.000Z' },
    },
  },
}

function slotProject(vm) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-physical-'))
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  const vmPath = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  return { root, vmPath, read: () => JSON.parse(fs.readFileSync(vmPath, 'utf8')) }
}

function writeFiles(base, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(base, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
}

const NOW = () => new Date('2026-10-25T08:00:00.000Z')

// ---- F + D: precheck, Chinese errors, persisted failure ----

test('collect on a Grok slot without a container: 409 Chinese reason, no exec, failure persisted', async () => {
  const vm = { id: 'vm-grok1', ...GROK, fingerprint: {} }
  const p = slotProject(vm)
  let execs = 0
  try {
    const out = await collectSlotIdentity(p.root, vm, {
      inspect: async () => ({ exists: false, running: false }),
      callGet: async () => {
        execs += 1
        return GUEST
      },
      now: NOW,
    })
    assert.equal(out.ok, false)
    assert.equal(out.status, 409)
    assert.equal(out.code, 'slot_container_missing')
    assert.match(out.error, /该槽没有运行中的容器/)
    assert.match(out.error, /Grok 槽推理不依赖容器/)
    assert.match(out.error, /kin-grok1/)
    assert.doesNotMatch(out.error, /Error response from daemon/)
    assert.equal(execs, 0)
    const saved = p.read()
    assert.deepEqual(saved.runtime.identity_collect_error, {
      code: 'slot_container_missing',
      message: out.error,
      at: '2026-10-25T08:00:00.000Z',
    })
    assert.equal(saved.runtime.type, 'docker')
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

test('collect on a stopped container reports slot_container_stopped with its state', async () => {
  const vm = { id: 'vm-gpt1', platform: 'openai', family: 'gpt', runtime: { type: 'docker' } }
  const p = slotProject(vm)
  try {
    const out = await collectSlotIdentity(p.root, vm, {
      inspect: async () => ({ exists: true, running: false, status: 'exited' }),
      callGet: async () => assert.fail('must not exec into a stopped container'),
      now: NOW,
    })
    assert.equal(out.status, 409)
    assert.equal(out.code, 'slot_container_stopped')
    assert.match(out.error, /容器未运行/)
    assert.match(out.error, /状态 exited/)
    assert.match(out.error, /GPT 槽推理由主机 Codex 内核负责/)
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

test('a failing inspect does not block the exec; raw docker errors are translated', async () => {
  const vm = { id: 'vm-grok2', ...GROK }
  const p = slotProject(vm)
  try {
    const out = await collectSlotIdentity(p.root, vm, {
      inspect: async () => {
        throw new Error('socket hang up')
      },
      callGet: async () => ({
        ok: false,
        status: 502,
        body: {
          error: {
            code: 'guest_identity_exec_failed',
            message: 'Error response from daemon: No such container: kin-grok2',
          },
        },
      }),
      now: NOW,
    })
    assert.equal(out.code, 'slot_container_missing')
    assert.equal(out.status, 409)
    assert.match(out.error, /请先开机再采集/)
    assert.equal(p.read().runtime.identity_collect_error.code, 'slot_container_missing')
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

test('describeCollectFailure maps docker / timeout / invalid / unknown text to Chinese', () => {
  const vm = { id: 'vm-x', ...GROK }
  assert.equal(
    describeCollectFailure(vm, { raw: 'Error response from daemon: Container abc is not running' }).code,
    'slot_container_stopped',
  )
  const daemon = describeCollectFailure(vm, {
    raw: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
  })
  assert.equal(daemon.code, 'docker_unavailable')
  assert.equal(daemon.status, 503)
  assert.match(daemon.message, /无法连接 Docker/)
  assert.equal(describeCollectFailure(vm, { raw: 'spawn docker ENOENT' }).code, 'docker_unavailable')
  const slow = describeCollectFailure(vm, { code: 'guest_identity_timeout', timeoutMs: 5000 })
  assert.equal(slow.status, 504)
  assert.match(slow.message, /采集超时（5 秒）/)
  assert.match(describeCollectFailure(vm, { code: 'guest_identity_invalid' }).message, /不完整/)
  const other = describeCollectFailure(vm, { code: 'weird', raw: 'boom' })
  assert.equal(other.status, 502)
  assert.equal(other.message, '采集失败：boom')
})

test('a successful collect clears the last failure', async () => {
  const vm = {
    id: 'vm-grok3',
    ...GROK,
    fingerprint: {},
    runtime: { type: 'docker', identity_collect_error: { code: 'slot_container_missing', message: 'x', at: 't' } },
  }
  const p = slotProject(vm)
  try {
    const out = await collectSlotIdentity(p.root, vm, {
      inspect: async () => ({ exists: true, running: true }),
      callGet: async () => GUEST,
    })
    assert.equal(out.ok, true, JSON.stringify(out))
    const saved = p.read()
    assert.equal(saved.runtime.identity_collect_error, undefined)
    assert.equal(saved.fingerprint.hardware.cpu_model, 'Intel Core i7')
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

test('an injected reader without inspect skips the precheck (fleet tools, old callers)', async () => {
  const vm = { id: 'vm-grok4', ...GROK, fingerprint: {} }
  const p = slotProject(vm)
  try {
    const out = await collectSlotIdentity(p.root, vm, { callGet: async () => GUEST })
    assert.equal(out.ok, true)
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

test('collectSlotIdentityOnce joins a running collect for the same slot', async () => {
  const vm = { id: 'vm-grok5', ...GROK, fingerprint: {} }
  const p = slotProject(vm)
  let execs = 0
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const opts = {
    inspect: null,
    callGet: async () => {
      execs += 1
      await gate
      return GUEST
    },
  }
  try {
    const a = collectSlotIdentityOnce(p.root, vm, opts)
    const b = collectSlotIdentityOnce(p.root, vm, opts)
    assert.equal(a, b)
    release()
    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra.ok, true)
    assert.equal(rb.ok, true)
    assert.equal(execs, 1)
    await collectSlotIdentityOnce(p.root, vm, opts)
    assert.equal(execs, 2, 'a finished collect does not stay cached')
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

// ---- A: background auto-collect after a start ----

test('auto-collect runs once for a never-collected docker slot and swallows failures', async () => {
  const vm = { id: 'vm-grok6', ...GROK, fingerprint: {} }
  const p = slotProject(vm)
  const timers = []
  const calls = []
  try {
    const opts = {
      delayMs: 10,
      setTimer: (fn) => timers.push(fn),
      collect: async (_root, v) => {
        calls.push(v.id)
        throw new Error('docker exploded')
      },
    }
    assert.deepEqual(scheduleIdentityAutoCollect(p.root, vm.id, opts), { scheduled: true })
    assert.equal(scheduleIdentityAutoCollect(p.root, vm.id, opts).reason, 'in_flight')
    assert.equal(timers.length, 1)
    timers[0]()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(calls, ['vm-grok6'])
    // After the timer fired the slot may be scheduled again (e.g. the next start).
    assert.equal(scheduleIdentityAutoCollect(p.root, vm.id, opts).scheduled, true)
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

test('auto-collect skips KVM, already-collected and missing slots', () => {
  const kvm = slotProject({ id: 'vm-k1', runtime: { type: 'kvm' } })
  const done = slotProject({ id: 'vm-d1', ...GROK, fingerprint: { hardware: { observed_at: '2026-10-01T00:00:00Z' } } })
  const never = () => assert.fail('must not schedule')
  try {
    assert.equal(scheduleIdentityAutoCollect(kvm.root, 'vm-k1', { setTimer: never }).reason, 'kvm')
    assert.equal(scheduleIdentityAutoCollect(done.root, 'vm-d1', { setTimer: never }).reason, 'already_collected')
    assert.equal(scheduleIdentityAutoCollect(done.root, 'vm-nope', { setTimer: never }).reason, 'vm_missing')
    assert.equal(scheduleIdentityAutoCollect(done.root, '../etc', { setTimer: never }).reason, 'vm_missing')
  } finally {
    fs.rmSync(kvm.root, { recursive: true, force: true })
    fs.rmSync(done.root, { recursive: true, force: true })
  }
})

// ---- G: host-side kin-computer identity files ----

test('readSlotIdentityProfile reads docker kin-computer files without writing anything', () => {
  const p = slotProject({ id: 'vm-grok7', ...GROK })
  const dir = path.join(p.root, 'vms', 'vm-grok7', 'kvm', 'fingerprint', 'system')
  writeFiles(dir, {
    'etc/hostname': 'imac15-1-ab12\n',
    'etc/machine-id': '0123456789abcdef0123456789abcdef\n',
    'hardware/mac': '3C:22:FB:00:11:22\n',
    'hardware/cpu_brand': 'Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz\n',
    'hardware/logical_cpus': '16\n',
    'hardware/ram_bytes': '34359738368\n',
    'dmi/id/sys_vendor': 'Apple Inc.\n',
    'dmi/id/product_name': 'iMac20,1\n',
    'dmi/id/product_serial': 'C02ABC123\n',
  })
  try {
    const before = fs.readdirSync(dir, { recursive: true }).sort()
    const prof = readSlotIdentityProfile(p.root, { id: 'vm-grok7', ...GROK })
    assert.equal(prof.source, 'profile')
    assert.equal(prof.hostname, 'imac15-1-ab12')
    assert.equal(prof.machine_id_present, true)
    assert.equal(prof.mac, '3c:22:fb:00:11:22')
    assert.equal(prof.cpu_model, 'Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz')
    assert.equal(prof.cpu_cores, 16)
    assert.equal(prof.memory_bytes, 34359738368)
    assert.deepEqual(prof.dmi, {
      manufacturer: 'Apple Inc.',
      product: 'iMac20,1',
      version: null,
      family: null,
      serial: 'C02ABC123',
      uuid: null,
    })
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before)
    assert.equal(readSlotIdentityProfile(p.root, { id: 'vm-none', ...GROK }), null)
    assert.equal(readSlotIdentityProfile(null, { id: 'vm-grok7' }), null)
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

test('readSlotIdentityProfile reads KVM identity.json and the SMBIOS type=1 args', () => {
  const p = slotProject({ id: 'vm-k2', runtime: { type: 'kvm' } })
  const dir = path.join(p.root, 'vms', 'vm-k2', 'kvm', 'fingerprint')
  writeFiles(dir, {
    'identity.json': JSON.stringify({ hostname: 'ws-01', machine_id: 'ab'.repeat(16), uuid: 'x' }),
    'qemu-smbios.args':
      '-uuid\n4c4c4544-0000-1000-8000-000000000001\n-smbios\ntype=0,vendor=Dell\n-smbios\ntype=1,manufacturer=Dell Inc.,product=OptiPlex 7090,serial=ABC,,1\n',
  })
  try {
    const prof = readSlotIdentityProfile(p.root, { id: 'vm-k2', runtime: { type: 'kvm' } })
    assert.equal(prof.hostname, 'ws-01')
    assert.equal(prof.machine_id_present, true)
    assert.equal(prof.dmi.manufacturer, 'Dell Inc.')
    assert.equal(prof.dmi.product, 'OptiPlex 7090')
    assert.equal(prof.dmi.serial, 'ABC,1')
    assert.equal(prof.dmi.uuid, '4c4c4544-0000-1000-8000-000000000001')
    assert.equal(parseSmbiosType1('type=0,vendor=x'), null)
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})

// ---- B1: no vm.machine fallback for docker; DMI from a single source ----

const SPEC = {
  memory: '2g',
  vcpus: 4,
  cpu_model: 'host',
  mac: '52:54:00:aa:bb:cc',
  disk_serial: 'KIN0123',
  smbios: { manufacturer: 'Acer', product: 'Aspire TC-895', version: '1.0', serial: 'ACER-SN' },
}

test('docker slot without collect or profile shows no spec MAC/CPU/disk/SMBIOS/vcpus', () => {
  const f = publicPhysicalFeatures({ id: 'vm-grok1', ...GROK, machine: SPEC, fingerprint: { hostname: 'imac15-1-x' } })
  assert.equal(f.mac, null)
  assert.equal(f.cpu_model, null)
  assert.equal(f.cpu_cores, null)
  assert.equal(f.root_disk, null)
  assert.equal(f.dmi, null)
  assert.equal(f.memory_bytes, 2 * 1024 * 1024 * 1024, 'the applied --memory limit is real')
  assert.equal(f.sources.memory_bytes, 'spec')
  assert.equal(f.hostname, 'imac15-1-x')
  assert.equal(f.sources.hostname, 'config')
  assert.equal(f.observed_at, null)
  assert.doesNotMatch(JSON.stringify(f), /52:54:00|KIN0123|Acer/)
})

test('docker slot uses the host profile, labelled as such, and docker_cpus as the core count', () => {
  const profile = {
    source: 'profile',
    hostname: 'imac15-1-ab12',
    machine_id_present: true,
    cpu_model: 'Intel i7',
    cpu_cores: 16,
    memory_bytes: 34359738368,
    mac: '3c:22:fb:00:11:22',
    dmi: { manufacturer: 'Apple Inc.', product: 'iMac20,1' },
  }
  const f = publicPhysicalFeatures(
    { id: 'vm-grok1', ...GROK, machine: { ...SPEC, docker_cpus: 1.5 }, fingerprint: {} },
    { profile },
  )
  assert.equal(f.hostname, 'imac15-1-ab12')
  assert.equal(f.mac, '3c:22:fb:00:11:22')
  assert.equal(f.cpu_model, 'Intel i7')
  assert.equal(f.cpu_cores, 2)
  assert.equal(f.machine_id_present, true)
  assert.deepEqual(f.dmi, {
    manufacturer: 'Apple Inc.',
    product: 'iMac20,1',
    version: null,
    family: null,
    serial: null,
    uuid: null,
  })
  assert.deepEqual(f.sources, {
    hostname: 'profile',
    machine_id: 'profile',
    cpu_model: 'profile',
    cpu_cores: 'spec',
    memory_bytes: 'spec',
    root_disk: null,
    mac: 'profile',
    dmi: 'profile',
  })
})

test('collected DMI is never completed field by field from the profile or spec', () => {
  const f = publicPhysicalFeatures(
    {
      id: 'vm-k3',
      runtime: { type: 'kvm' },
      machine: SPEC,
      fingerprint: {
        collected_at: '2026-10-25T00:00:00Z',
        hardware: { observed_at: '2026-10-25T00:00:00Z', dmi: { manufacturer: 'Dell Inc.' } },
      },
    },
    { profile: { dmi: { manufacturer: 'Apple Inc.', product: 'iMac20,1', serial: 'P' } } },
  )
  assert.deepEqual(f.dmi, {
    manufacturer: 'Dell Inc.',
    product: null,
    version: null,
    family: null,
    serial: null,
    uuid: null,
  })
  assert.equal(f.sources.dmi, 'collected')
})

test('KVM slots keep the vm.machine fallback; collect_error is exposed', () => {
  const f = publicPhysicalFeatures({
    id: 'vm-k4',
    runtime: { type: 'kvm', identity_collect_error: { code: 'guest_identity_timeout', message: '采集超时', at: 't' } },
    machine: SPEC,
    fingerprint: {},
  })
  assert.equal(f.mac, '52:54:00:aa:bb:cc')
  assert.equal(f.cpu_model, 'host')
  assert.equal(f.cpu_cores, 4)
  assert.equal(f.root_disk, 'KIN0123')
  assert.equal(f.dmi.manufacturer, 'Acer')
  assert.equal(f.sources.dmi, 'spec')
  assert.deepEqual(f.collect_error, { code: 'guest_identity_timeout', message: '采集超时', at: 't' })
})

// ---- diagnostics ----

function healthyProbes(over = {}) {
  return {
    container: async () => ({ exists: true, running: true, status: 'running' }),
    rustHealth: async () => ({ ok: true, healthy: true, ready_slots: 3, cli_pid: 42 }),
    codexHealth: async () => ({ ok: true }),
    localEgress: () => ({ ok: true }),
    socksEgress: () => ({ ok: true }),
    remoteEgress: async () => ({ exists: true, running: true }),
    cluster: () => null,
    ...over,
  }
}

test('diagnostics: a missing container is a warning on Grok slots, still an error on Claude', async () => {
  const grok = { id: 'vm-grok8', ...GROK, status: 'running', proxy: { id: 'px', url: 'socks5://h:1' } }
  const claude = { id: 'vm-c8', status: 'running', proxy: { id: 'px', url: 'socks5://h:1' } }
  const p = slotProject(grok)
  fs.writeFileSync(path.join(p.root, 'vms', `${claude.id}.json`), JSON.stringify(claude))
  const missing = healthyProbes({ container: async () => ({ exists: false, running: false }) })
  try {
    const g = await diagnoseSlotServices(grok, { projectRoot: p.root, probes: missing })
    const gc = g.checks.find((c) => c.id === 'container')
    assert.equal(gc.status, 'warn')
    assert.equal(gc.code, 'container_missing')
    assert.match(gc.message, /Grok 推理不依赖容器/)
    const c = await diagnoseSlotServices(claude, { projectRoot: p.root, probes: missing })
    assert.equal(c.checks.find((x) => x.id === 'container').status, 'error')
  } finally {
    fs.rmSync(p.root, { recursive: true, force: true })
  }
})
