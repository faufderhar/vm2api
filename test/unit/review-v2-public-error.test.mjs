import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicError, operatorErrorMessage, publicError } from '../../src/lib/core/public-error.mjs'
import { publicErrorMessage } from '../../src/lib/core/security.mjs'

test('L-4: unexpected faults stay generic', () => {
  assert.equal(publicErrorMessage(new Error('ENOENT: open /var/lib/vm2api/state.json')), 'internal server error')
  const coded = Object.assign(new Error('SQLITE_ERROR near "x"'), { code: 'SQLITE_ERROR' })
  assert.equal(publicErrorMessage(coded), 'internal server error')
})

test('L-4: PublicError keeps its operator message and code', () => {
  const e = new PublicError('计算机服务未安装。', { status: 503, code: 'computer_service_missing' })
  assert.equal(e.status, 503)
  assert.equal(e.expose, true)
  assert.equal(publicErrorMessage(e), '计算机服务未安装。')
  assert.equal(publicErrorMessage(publicError(409, 'proxy_required', 'slot SOCKS5 proxy is required')), 'slot SOCKS5 proxy is required')
})

test('L-4: exposed text loses stack frames and absolute paths, URLs survive', () => {
  const msg = operatorErrorMessage(
    new Error('failed to read /home/kin/.vm2api/vms/abc/token (see https://api.example.com/v1/models)\n    at foo (/app/x.mjs:1:2)')
  )
  assert.equal(msg, 'failed to read <path> (see https://api.example.com/v1/models)')
  assert.equal(publicErrorMessage(Object.assign(new Error('bad /etc/passwd'), { status: 400 })), 'bad <path>')
  assert.ok(operatorErrorMessage('x'.repeat(2000)).length <= 501)
})

test('L-4: slot computer missing binary is a PublicError (shown in the panel again)', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l4-'))
  const prev = process.env.KIN_COMPUTER_BIN
  process.env.KIN_COMPUTER_BIN = path.join(root, 'missing-kin-computer')
  try {
    const { ensureSlotComputer } = await import('../../src/lib/identity/slot-computer.mjs')
    assert.equal(typeof ensureSlotComputer, 'function')
    let raised
    try {
      ensureSlotComputer(root, { id: 'vm-l4', kernel: 'ubuntu-24.04', runtime: { type: 'docker' } })
    } catch (e) {
      raised = e
    }
    assert.ok(raised, 'expected a throw')
    assert.equal(raised.code, 'computer_service_missing')
    assert.equal(raised.status, 503)
    assert.match(publicErrorMessage(raised), /计算机服务未安装/)
  } finally {
    if (prev === undefined) delete process.env.KIN_COMPUTER_BIN
    else process.env.KIN_COMPUTER_BIN = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
})
