/**
 * Read-only view of a slot's kin-computer identity files on the host.
 *
 * kin-computer writes them at slot create (vms/<id>/kvm/fingerprint), before any
 * container exists, and docker slots mount them read-only into the guest
 * (/etc/hostname, /etc/kin-hardware, /etc/kin-dmi). So they are what the guest
 * will report once it runs: the panel shows them as 「来自档案」 until a collect.
 * Never writes or regenerates anything; a missing or partial file just yields null.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fingerprintDir } from './slot-computer.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'

const MAX_FILE_BYTES = 4096

function readText(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
    const text = fs.readFileSync(file, 'utf8').trim()
    return text || null
  } catch {
    return null
  }
}

function readInt(file) {
  const text = readText(file)
  if (!text || !/^\d+$/.test(text)) return null
  const n = Number.parseInt(text, 10)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function dmiOrNull(dmi) {
  return Object.values(dmi).some(Boolean) ? dmi : null
}

/** Split a QEMU option string on single commas; `,,` is a literal comma. */
function splitQemuOpts(text) {
  const parts = []
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ',' && text[i + 1] === ',') {
      cur += ','
      i++
    } else if (text[i] === ',') {
      parts.push(cur)
      cur = ''
    } else cur += text[i]
  }
  parts.push(cur)
  return parts
}

/** DMI from qemu-smbios.args (one argv item per line: `-smbios` then `type=1,…`; `-uuid` then the uuid). */
export function parseSmbiosType1(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  let type1 = ''
  let uuid = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '-uuid' && lines[i + 1] && !lines[i + 1].startsWith('-')) uuid = lines[++i]
    else if (line === '-smbios' && lines[i + 1]?.startsWith('type=1,')) type1 = lines[++i]
    else if (line.startsWith('-smbios type=1,')) type1 = line.slice('-smbios '.length)
    else if (line.startsWith('type=1,')) type1 = line
  }
  if (!type1) return null
  const out = {}
  for (const part of splitQemuOpts(type1)) {
    const at = part.indexOf('=')
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1).trim()
  }
  return dmiOrNull({
    manufacturer: out.manufacturer || null,
    product: out.product || null,
    version: out.version || null,
    family: out.family || null,
    serial: out.serial || null,
    uuid: out.uuid || uuid || null,
  })
}

function kvmProfile(dir) {
  let ident = null
  try {
    const raw = readText(path.join(dir, 'identity.json'))
    ident = raw ? JSON.parse(raw) : null
  } catch {
    ident = null
  }
  const dmi = parseSmbiosType1(readText(path.join(dir, 'qemu-smbios.args')))
  if (!ident && !dmi) return null
  return {
    source: 'profile',
    hostname: typeof ident?.hostname === 'string' && ident.hostname.trim() ? ident.hostname.trim() : null,
    machine_id_present: typeof ident?.machine_id === 'string' && ident.machine_id.trim() !== '',
    cpu_model: null,
    cpu_cores: null,
    memory_bytes: null,
    mac: null,
    dmi,
  }
}

function dockerProfile(dir) {
  const sys = path.join(dir, 'system')
  const hw = path.join(sys, 'hardware')
  const dmiDir = path.join(sys, 'dmi', 'id')
  const mac = readText(path.join(hw, 'mac'))
  const profile = {
    source: 'profile',
    hostname: readText(path.join(sys, 'etc', 'hostname')),
    machine_id_present: !!readText(path.join(sys, 'etc', 'machine-id')),
    cpu_model: readText(path.join(hw, 'cpu_brand')),
    cpu_cores: readInt(path.join(hw, 'logical_cpus')),
    memory_bytes: readInt(path.join(hw, 'ram_bytes')),
    mac: mac ? mac.toLowerCase() : null,
    dmi: dmiOrNull({
      manufacturer: readText(path.join(dmiDir, 'sys_vendor')),
      product: readText(path.join(dmiDir, 'product_name')),
      version: readText(path.join(dmiDir, 'product_version')),
      family: readText(path.join(dmiDir, 'product_family')),
      serial: readText(path.join(dmiDir, 'product_serial')),
      uuid: readText(path.join(dmiDir, 'product_uuid')),
    }),
  }
  const any =
    profile.hostname ||
    profile.machine_id_present ||
    profile.cpu_model ||
    profile.cpu_cores ||
    profile.memory_bytes ||
    profile.mac ||
    profile.dmi
  return any ? profile : null
}

/** Host-side identity profile for one slot, or null (remote node, never assigned, unreadable). */
export function readSlotIdentityProfile(projectRoot, vm) {
  const id = String(vm?.id || '').trim()
  if (!projectRoot || !id || id.includes('/') || id.includes('..')) return null
  const dir = fingerprintDir(projectRoot, id)
  try {
    if (!fs.statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  return isKvmRuntime(vm) ? kvmProfile(dir) : dockerProfile(dir)
}
