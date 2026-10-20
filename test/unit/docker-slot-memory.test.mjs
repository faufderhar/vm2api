import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  formatDockerMemoryBytes,
  inspectDockerContainerMemory,
  parseCgroupMemoryLimit,
  raiseDockerSlotMemory,
  validateDockerMemoryRaise,
} from '../../src/lib/vm/docker-slot-memory.mjs'

test('formatDockerMemoryBytes normalizes docker byte limits', () => {
  assert.equal(formatDockerMemoryBytes(536870912), '512m')
  assert.equal(formatDockerMemoryBytes(1073741824), '1g')
})

test('parseCgroupMemoryLimit handles v2 max and v1 unlimited sentinel', () => {
  assert.deepEqual(parseCgroupMemoryLimit('max'), { kind: 'unlimited' })
  assert.deepEqual(parseCgroupMemoryLimit('9223372036854771712'), { kind: 'unlimited' })
  assert.deepEqual(parseCgroupMemoryLimit(String(1024 ** 3)), { kind: 'limited', bytes: 1024 ** 3 })
  assert.deepEqual(parseCgroupMemoryLimit(''), { kind: 'unreadable' })
})

test('validateDockerMemoryRaise rejects kvm and invalid or non-increasing memory', () => {
  const kvm = { id: 'vm-1', runtime_type: 'kvm', machine: { memory: '512m' } }
  const kvmCheck = validateDockerMemoryRaise(kvm, '1g', {})
  assert.equal(kvmCheck.ok, false)
  assert.equal(kvmCheck.code, 'kvm_memory_raise_forbidden')

  const docker = { id: 'vm-2', runtime_type: 'docker', machine: { memory: '1g' } }
  assert.equal(validateDockerMemoryRaise(docker, '3g', {}).ok, false)
  assert.equal(validateDockerMemoryRaise(docker, '512m', {}).code, 'memory_not_increased')
  assert.equal(validateDockerMemoryRaise(docker, '2g', {}).ok, true)
})

function tmpVmRecord(root, id, machine = { memory: '512m' }) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, status: 'running', machine, runtime: { type: 'docker', memory: machine.memory } }),
  )
}

test('raiseDockerSlotMemory persists only after docker update and inspect succeed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-raise-'))
  try {
    const id = 'vm-01'
    tmpVmRecord(root, id)
    const vm = { id, runtime_type: 'docker', machine: { memory: '512m' }, runtime: { type: 'docker', memory: '512m' } }
    const calls = []
    let updated = false
    const execImpl = (argv) => {
      calls.push(argv.join(' '))
      if (argv.includes('update')) {
        updated = true
        return { ok: true, stdout: '', stderr: '' }
      }
      if (argv.includes('inspect')) {
        const bytes = updated ? 1024 ** 3 : 512 * 1024 ** 2
        return { ok: true, stdout: `${bytes} ${bytes} true`, stderr: '' }
      }
      if (argv.includes('exec')) return { ok: true, stdout: String(1024 ** 3), stderr: '' }
      return { ok: false, stderr: 'unexpected' }
    }
    const raised = raiseDockerSlotMemory(root, vm, '1g', { execImpl })
    assert.equal(raised.ok, true)
    assert.equal(raised.memory, '1g')
    assert.match(calls.join('\n'), /--memory-swap 1g/)
    assert.match(calls.join('\n'), /memory\.max/)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(saved.machine.memory, '1g')
    assert.equal(saved.runtime.memory, '1g')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('raiseDockerSlotMemory does not persist when docker update fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-fail-'))
  try {
    const id = 'vm-02'
    tmpVmRecord(root, id)
    const vm = { id, runtime_type: 'docker', machine: { memory: '512m' } }
    const execImpl = (argv) => {
      if (argv.includes('update')) return { ok: false, stderr: 'cannot update' }
      if (argv.includes('inspect')) {
        const bytes = 512 * 1024 ** 2
        return { ok: true, stdout: `${bytes} ${bytes} true`, stderr: '' }
      }
      return { ok: false, stderr: 'unexpected' }
    }
    const raised = raiseDockerSlotMemory(root, vm, '1g', { execImpl })
    assert.equal(raised.ok, false)
    assert.equal(raised.code, 'docker_update_failed')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(saved.machine.memory, '512m')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('inspectDockerContainerMemory reads memory, swap and running state', () => {
  const vm = { id: 'vm-03', runtime_type: 'docker' }
  const out = inspectDockerContainerMemory(vm, (argv) => {
    assert.match(argv.join(' '), /inspect.*HostConfig\.Memory/)
    return { ok: true, stdout: `${2 * 1024 ** 3} ${2 * 1024 ** 3} true`, stderr: '' }
  })
  assert.equal(out.ok, true)
  assert.equal(out.memory, '2g')
  assert.equal(out.swapBytes, 2 * 1024 ** 3)
  assert.equal(out.running, true)
})

test('raiseDockerSlotMemory refuses a stopped container before docker update', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-stopped-'))
  try {
    tmpVmRecord(root, 'vm-06')
    const vm = { id: 'vm-06', runtime_type: 'docker', machine: { memory: '512m' } }
    const execImpl = (argv) => {
      assert.ok(argv.includes('inspect'))
      return { ok: true, stdout: `${512 * 1024 ** 2} -1 false` }
    }
    assert.equal(raiseDockerSlotMemory(root, vm, '1g', { execImpl }).code, 'container_not_running')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-06.json'), 'utf8')).machine.memory, '512m')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('raiseDockerSlotMemory refuses a mismatched swap limit without persisting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-swap-'))
  try {
    tmpVmRecord(root, 'vm-04')
    const vm = { id: 'vm-04', runtime_type: 'docker', machine: { memory: '512m' } }
    let updated = false
    let rollback = false
    const execImpl = (argv) => {
      if (argv.includes('update')) {
        if (argv.includes('512m') && updated) {
          rollback = true
          updated = false
        } else {
          updated = true
        }
        return { ok: true, stdout: '' }
      }
      if (argv.includes('inspect')) {
        const memory = updated ? 1024 ** 3 : 512 * 1024 ** 2
        const swap = updated ? 512 * 1024 ** 2 : 512 * 1024 ** 2
        return { ok: true, stdout: `${memory} ${swap} true` }
      }
      return { ok: false, stderr: 'unexpected' }
    }
    const raised = raiseDockerSlotMemory(root, vm, '1g', { execImpl })
    assert.equal(raised.code, 'memory_diverged')
    assert.equal(raised.rollback_succeeded, true)
    assert.equal(rollback, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-04.json'), 'utf8')).machine.memory, '512m')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('raiseDockerSlotMemory refuses a mismatched cgroup limit without persisting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-cgroup-'))
  try {
    tmpVmRecord(root, 'vm-05')
    const vm = { id: 'vm-05', runtime_type: 'docker', machine: { memory: '512m' } }
    let updated = false
    let rollback = false
    const execImpl = (argv) => {
      if (argv.includes('update')) {
        if (argv.includes('512m') && updated) {
          rollback = true
          updated = false
        } else {
          updated = true
        }
        return { ok: true, stdout: '' }
      }
      if (argv.includes('inspect')) {
        const bytes = updated ? 1024 ** 3 : 512 * 1024 ** 2
        return { ok: true, stdout: `${bytes} ${bytes} true` }
      }
      if (argv.includes('exec')) return { ok: true, stdout: String(512 * 1024 ** 2) }
      return { ok: false, stderr: 'unexpected' }
    }
    const raised = raiseDockerSlotMemory(root, vm, '1g', { execImpl })
    assert.equal(raised.code, 'cgroup_memory_diverged')
    assert.equal(raised.rollback_succeeded, true)
    assert.equal(rollback, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-05.json'), 'utf8')).machine.memory, '512m')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('raiseDockerSlotMemory accepts cgroup v1 limit when memory.max is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-cgroup-v1-'))
  try {
    const id = 'vm-07'
    tmpVmRecord(root, id)
    const vm = { id, runtime_type: 'docker', machine: { memory: '512m' } }
    let updated = false
    const execImpl = (argv) => {
      if (argv.includes('update')) {
        updated = true
        return { ok: true, stdout: '' }
      }
      if (argv.includes('inspect')) {
        const bytes = updated ? 1024 ** 3 : 512 * 1024 ** 2
        return { ok: true, stdout: `${bytes} ${bytes} true` }
      }
      if (argv.join(' ').includes('memory.max')) return { ok: false, stderr: 'No such file' }
      if (argv.join(' ').includes('limit_in_bytes')) return { ok: true, stdout: String(1024 ** 3) }
      return { ok: false, stderr: 'unexpected' }
    }
    const raised = raiseDockerSlotMemory(root, vm, '1g', { execImpl })
    assert.equal(raised.ok, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8')).machine.memory, '1g')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('raiseDockerSlotMemory accepts memory.max=max when HostConfig already matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mem-cgroup-max-'))
  try {
    const id = 'vm-08'
    tmpVmRecord(root, id)
    const vm = { id, runtime_type: 'docker', machine: { memory: '512m' } }
    let updated = false
    const execImpl = (argv) => {
      if (argv.includes('update')) {
        updated = true
        return { ok: true, stdout: '' }
      }
      if (argv.includes('inspect')) {
        const bytes = updated ? 1024 ** 3 : 512 * 1024 ** 2
        return { ok: true, stdout: `${bytes} ${bytes} true` }
      }
      if (argv.includes('exec')) return { ok: true, stdout: 'max' }
      return { ok: false, stderr: 'unexpected' }
    }
    const raised = raiseDockerSlotMemory(root, vm, '1g', { execImpl })
    assert.equal(raised.ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
