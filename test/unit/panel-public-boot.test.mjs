import test from 'node:test'
import assert from 'node:assert/strict'
import {
  publicAllocatedProxy,
  publicPhysicalFeatures,
  publicRuntimeView,
  publicSlotBoot,
  publicVmBootView,
} from '../../src/lib/admin/panel-api.mjs'

test('publicAllocatedProxy uses publicProxy and drops credentials', () => {
  const bound = {
    id: 'px-1',
    host: '1.2.3.4',
    port: 1080,
    username: 'alice',
    password: 's3cret',
    url: 'socks5://alice:s3cret@1.2.3.4:1080',
  }
  const pool = {
    state: {
      proxies: [{ id: 'px-1', host: '1.2.3.4', port: 1080, username: 'alice', password: 's3cret' }],
    },
    publicProxy(p) {
      return { id: p.id, host: p.host, port: p.port, has_auth: !!(p.username || p.password) }
    },
  }
  const view = publicAllocatedProxy(pool, bound)
  const raw = JSON.stringify(view)
  assert.equal(view.id, 'px-1')
  assert.equal(view.has_auth, true)
  assert.doesNotMatch(raw, /alice|s3cret|socks5:\/\//)
})

test('publicAllocatedProxy fallback omits url and password when pool miss', () => {
  const view = publicAllocatedProxy(null, {
    id: 'px-2',
    host: '9.9.9.9',
    port: 1081,
    username: 'bob',
    password: 'pw',
    url: 'socks5://bob:pw@9.9.9.9:1081',
    has_auth: true,
  })
  assert.equal(view.host, '9.9.9.9')
  assert.equal(view.has_auth, true)
  assert.equal(view.url, undefined)
  assert.equal(view.username, undefined)
  assert.equal(view.password, undefined)
})

test('publicSlotBoot and publicRuntimeView drop host infrastructure', () => {
  const boot = publicSlotBoot({
    ok: true,
    action: 'started',
    engine: 'rust',
    rust_ok: true,
    runtime: {
      container_id: 'abc123deadbeef',
      ip: '166.88.96.199',
      pid: 4242,
      worker_run_dir: '/opt/vm2api/vms/vm-01/run',
      worker_token_file: '/opt/vm2api/vms/vm-01/run/internal.token',
    },
    rust: { ok: true, skipped: false, health: { ok: true }, error: null },
  })
  const raw = JSON.stringify(boot)
  assert.equal(boot.ok, true)
  assert.equal(boot.action, 'started')
  assert.equal(boot.runtime, undefined)
  assert.doesNotMatch(raw, /abc123deadbeef|166\.88\.96\.199|internal\.token|\/opt\/vm2api/)

  const runtime = publicRuntimeView({
    type: 'docker',
    container: 'kin-01',
    container_id: 'abc123deadbeef',
    ip: '1.1.1.1',
    pid: 9,
    worker_run_dir: '/opt/vm2api/vms/vm-01/run',
    worker_token_file: '/secret',
    worker: 'rust',
    egress: 'explicit-socks5',
  })
  assert.deepEqual(runtime, {
    type: 'docker',
    worker: 'rust',
    egress: 'explicit-socks5',
  })
  assert.equal(publicRuntimeView('docker-container'), 'docker-container')
})

test('publicVmBootView exposes state without account or infrastructure identifiers', () => {
  const view = publicVmBootView({
    id: 'vm-01',
    name: 'primary',
    status: 'running',
    platform: 'anthropic',
    family: 'claude',
    inference_engine: 'rust',
    persona_preset: 'official_full',
    schedulable: true,
    schedule_disabled_reason: null,
    email: 'owner@example.com',
    account_uuid: 'account-secret',
    org_uuid: 'org-secret',
    proxy: { id: 'px-1', url: 'socks5://secret' },
    fingerprint: { device_id: 'device-secret' },
    runtime: { container: 'kin-01', ip: '10.0.0.2', pid: 42 },
    ip: '10.0.0.2',
    pid: 42,
    container: 'kin-01',
  })
  assert.deepEqual(view, {
    id: 'vm-01',
    name: 'primary',
    status: 'running',
    platform: 'anthropic',
    family: 'claude',
    inference_engine: 'rust',
    persona_preset: 'official_full',
    schedulable: true,
    schedule_disabled_reason: null,
    runtime_type: 'docker',
    machine: null,
  })
  assert.doesNotMatch(JSON.stringify(view), /owner@example|secret|kin-01|10\.0\.0\.2/)
})

test('publicPhysicalFeatures exposes observed hardware without secrets', () => {
  const features = publicPhysicalFeatures({
    runtime: { type: 'kvm', identity_collected_at: '2026-10-17T00:00:00.000Z' },
    timezone: 'UTC',
    locale: 'C',
    email: 'owner@example.com',
    access_token: 'tok_secret',
    refresh_token: 'ref_secret',
    proxy: { username: 'alice', password: 's3cret', url: 'socks5://alice:s3cret@10.0.0.2:1080' },
    machine: {
      memory: '4g',
      vcpus: 2,
      cpu_model: 'host',
      mac: '52:54:00:11:22:33',
      disk_serial: 'configured-disk',
      smbios: { manufacturer: 'QEMU', product: 'Standard PC' },
    },
    fingerprint: {
      hostname: 'guest-01',
      os_id: 'ubuntu',
      os_pretty: 'Ubuntu 24.04 LTS',
      kernel_release: '6.8.0-51-generic',
      stainless_arch: 'x64',
      guest_machine_id: 'abc123deadbeefcafe',
      machine_id: 'raw-machine-id',
      device_id: 'device-secret',
      session_id: 'session-secret',
      official_machine_id: 'official-mid',
      official_user_id: 'official-user',
      collected_at: '2026-10-17T01:00:00.000Z',
      timezone: 'Asia/Tokyo',
      locale: 'en_US.UTF-8',
      hardware: {
        observed_at: '2026-10-17T01:02:00.000Z',
        cpu_model: 'Intel Core i7-11700',
        cpu_cores: 8,
        memory_bytes: 17179869184,
        root_disk: 'nvme0n1-serial',
        mac: '3c:22:fb:f9:50:9d',
        dmi: {
          manufacturer: 'Dell Inc.',
          product: 'OptiPlex 7090',
          version: '1.0',
          family: 'OptiPlex',
          serial: 'ABC123',
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
        shell: 'bash',
        package_managers: ['apt', 'dpkg'],
        runtimes: 'node',
        machine_id: 'hardware-machine-id',
        access_token: 'hw-token',
      },
    },
  })
  assert.equal(features.observed_at, '2026-10-17T01:02:00.000Z')
  assert.equal(features.runtime_type, 'kvm')
  assert.equal(features.hostname, 'guest-01')
  assert.equal(features.os_id, 'ubuntu')
  assert.equal(features.os_pretty, 'Ubuntu 24.04 LTS')
  assert.equal(features.kernel_release, '6.8.0-51-generic')
  assert.equal(features.arch, 'x64')
  assert.equal(features.machine_id_present, true)
  assert.equal(features.timezone, 'Asia/Tokyo')
  assert.equal(features.locale, 'en_US.UTF-8')
  assert.equal(features.cpu_model, 'Intel Core i7-11700')
  assert.equal(features.cpu_cores, 8)
  assert.equal(features.memory_bytes, 17179869184)
  assert.equal(features.root_disk, 'nvme0n1-serial')
  assert.equal(features.mac, '3c:22:fb:f9:50:9d')
  assert.deepEqual(features.dmi, {
    manufacturer: 'Dell Inc.',
    product: 'OptiPlex 7090',
    version: '1.0',
    family: 'OptiPlex',
    serial: 'ABC123',
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  })
  assert.equal(features.shell, 'bash')
  assert.equal(features.package_managers, 'apt, dpkg')
  assert.equal(features.runtimes, 'node')
  const raw = JSON.stringify(features)
  assert.doesNotMatch(
    raw,
    /tok_secret|ref_secret|alice|s3cret|device-secret|session-secret|official-mid|official-user|raw-machine-id|abc123deadbeefcafe|hardware-machine-id|hw-token|owner@example/,
  )
})

test('publicPhysicalFeatures falls back to public machine spec on KVM slots', () => {
  const features = publicPhysicalFeatures({
    runtime: { type: 'kvm' },
    timezone: 'America/Los_Angeles',
    machine: {
      memory: '2g',
      vcpus: 4,
      cpu_model: 'qemu64',
      mac: '52:54:00:aa:bb:cc',
      disk_serial: 'DISK123',
      smbios: { manufacturer: 'Dell Inc.', product: 'OptiPlex 7090' },
    },
    fingerprint: {},
  })
  assert.equal(features.runtime_type, 'kvm')
  assert.equal(features.cpu_model, 'qemu64')
  assert.equal(features.cpu_cores, 4)
  assert.equal(features.memory_bytes, 2 * 1024 * 1024 * 1024)
  assert.equal(features.root_disk, 'DISK123')
  assert.equal(features.mac, '52:54:00:aa:bb:cc')
  assert.equal(features.dmi.manufacturer, 'Dell Inc.')
  assert.equal(features.machine_id_present, false)
  assert.equal(features.observed_at, null)
  assert.equal(features.timezone, 'America/Los_Angeles')
})
