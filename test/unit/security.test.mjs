import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PANEL_SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const PANEL_SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000

test('panel admin has no hard-coded password fallback', async () => {
  const previous = process.env.KIN_ADMIN_PASSWORD
  delete process.env.KIN_ADMIN_PASSWORD
  try {
    const { getPanelAdmin } = await import(`../../src/lib/core/security.mjs?admin=${Date.now()}`)
    assert.equal(getPanelAdmin().username, process.env.KIN_ADMIN_USER || 'admin')
    assert.equal(getPanelAdmin().password, '')
  } finally {
    if (previous == null) delete process.env.KIN_ADMIN_PASSWORD
    else process.env.KIN_ADMIN_PASSWORD = previous
  }
})

test('panelCookieSecure follows PUBLIC_SCHEME then the request', async () => {
  const { panelCookieSecure, panelSessionCookie } = await import(`../../src/lib/core/security.mjs?cookie=${Date.now()}`)
  assert.equal(panelCookieSecure({}, { PUBLIC_SCHEME: 'http' }), false)
  assert.equal(panelCookieSecure({}, { PUBLIC_SCHEME: 'https' }), true)
  assert.equal(panelCookieSecure({ headers: { 'x-forwarded-proto': 'https' } }, {}), false)
  assert.equal(panelCookieSecure({ headers: { 'x-forwarded-proto': 'https' } }, { TRUST_PROXY: '1' }), true)
  assert.equal(panelCookieSecure({ headers: { 'x-forwarded-proto': 'http' } }, { TRUST_PROXY: '1' }), false)
  assert.equal(panelCookieSecure({ headers: {}, socket: {} }, {}), false)
  const httpCookie = panelSessionCookie('kin-panel-test', { secure: false })
  assert.doesNotMatch(httpCookie, /Secure/)
  const httpsCookie = panelSessionCookie('kin-panel-test', { secure: true })
  assert.match(httpsCookie, /Secure/)
})

test('master API key administers the panel only from loopback', async () => {
  const { masterMayAdminister } = await import(`../../src/lib/core/security.mjs?master=${Date.now()}`)
  assert.equal(masterMayAdminister({ apiKeyKind: 'master', panelRole: 'admin' }), true)
  assert.equal(masterMayAdminister({ apiKeyKind: 'master', socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(masterMayAdminister({ apiKeyKind: 'master', socket: { remoteAddress: '203.0.113.8' } }), false)
})

test('disabled or role-changed panel sessions are rejected and login limits are per account', async () => {
  const { panelSessionAccess, loginRateLimited, createAttemptLimiter } = await import(
    `../../src/lib/core/security.mjs?access=${Date.now()}`
  )
  assert.equal(panelSessionAccess({ role: 'admin' }, { enabled: false, role: 'admin' }).ok, false)
  assert.equal(panelSessionAccess({ role: 'admin' }, { enabled: true, role: 'user', id: 'u1' }).reason, 'role_changed')
  assert.equal(
    panelSessionAccess({ role: 'user' }, { enabled: true, role: 'user', id: 'u1', vm_create_quota: 2 }).ok,
    true,
  )
  const limiter = createAttemptLimiter({ limit: 1, windowMs: 60_000 })
  const shared = {
    socket: { remoteAddress: '10.0.0.8' },
    headers: { 'x-forwarded-for': '10.0.0.8' },
  }
  assert.equal(loginRateLimited(limiter, shared, 'alice', {}), false)
  assert.equal(loginRateLimited(limiter, shared, 'bob', {}), false)
  assert.equal(loginRateLimited(limiter, shared, 'alice', {}), true)
})

test('panel session persistence stores only token hashes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-security-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  try {
    const security = await import(`../../src/lib/core/security.mjs?session=${Date.now()}`)
    const token = security.createPanelSession('admin', 60_000)
    assert.match(token, /^kin-panel-/)
    assert.equal(security.verifyPanelSession(token).user, 'admin')
    const file = path.join(dir, 'panel-sessions.json')
    const stored = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(stored, /kin-panel-/)
    assert.doesNotMatch(stored, new RegExp(token))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const storedRow = Object.values(JSON.parse(stored))[0]
    assert.ok(storedRow.abs >= Date.now() + PANEL_SESSION_ABSOLUTE_MS - 5_000)
    assert.ok(storedRow.abs <= Date.now() + PANEL_SESSION_ABSOLUTE_MS + 1_000)
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.tmp')),
      [],
    )
    security.revokePanelSession(token)
    assert.equal(security.verifyPanelSession(token), null)
  } finally {
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPanelSession sliding-renews exp when remaining TTL is under half', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-security-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  try {
    const security = await import(`../../src/lib/core/security.mjs?slide=${Date.now()}`)
    const token = security.createPanelSession('admin', 60_000)
    const file = path.join(dir, 'panel-sessions.json')
    const before = JSON.parse(fs.readFileSync(file, 'utf8'))
    const storedKey = Object.keys(before)[0]
    const expBeforeVerify = before[storedKey].exp

    const security2 = await import(`../../src/lib/core/security.mjs?slide2=${Date.now()}`)
    assert.equal(security2.verifyPanelSession(token)?.user, 'admin')
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    const expAfterVerify = after[storedKey].exp
    assert.ok(expBeforeVerify <= Date.now() + 61_000)
    assert.ok(expAfterVerify >= Date.now() + PANEL_SESSION_TTL_MS - 5_000)
    assert.ok(expAfterVerify <= Date.now() + PANEL_SESSION_TTL_MS + 1_000)
  } finally {
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPanelSession does not slide past the absolute cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-security-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  try {
    const security = await import(`../../src/lib/core/security.mjs?cap=${Date.now()}`)
    const token = security.createPanelSession('admin', 60_000)
    const file = path.join(dir, 'panel-sessions.json')
    const before = JSON.parse(fs.readFileSync(file, 'utf8'))
    const storedKey = Object.keys(before)[0]
    const cap = Date.now() + 120_000
    before[storedKey].exp = Date.now() + 1_000
    before[storedKey].abs = cap
    fs.writeFileSync(file, JSON.stringify(before))

    const security2 = await import(`../../src/lib/core/security.mjs?cap2=${Date.now()}`)
    assert.equal(security2.verifyPanelSession(token)?.user, 'admin')
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after[storedKey].exp, cap)
    assert.equal(after[storedKey].abs, cap)
  } finally {
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPanelSession rejects a session past its absolute cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-security-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  try {
    const security = await import(`../../src/lib/core/security.mjs?abs=${Date.now()}`)
    const token = security.createPanelSession('admin')
    const file = path.join(dir, 'panel-sessions.json')
    const before = JSON.parse(fs.readFileSync(file, 'utf8'))
    const storedKey = Object.keys(before)[0]
    before[storedKey].exp = Date.now() + 60_000
    before[storedKey].abs = Date.now() - 1_000
    fs.writeFileSync(file, JSON.stringify(before))

    const security2 = await import(`../../src/lib/core/security.mjs?abs2=${Date.now()}`)
    assert.equal(security2.verifyPanelSession(token), null)
  } finally {
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPanelSession does not renew when more than half of TTL remains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-security-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  try {
    const security = await import(`../../src/lib/core/security.mjs?norel=${Date.now()}`)
    const token = security.createPanelSession('admin')
    const file = path.join(dir, 'panel-sessions.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const storedKey = Object.keys(raw)[0]
    const now = Date.now()
    raw[storedKey].exp = now + Math.floor(PANEL_SESSION_TTL_MS * 0.75)
    fs.writeFileSync(file, JSON.stringify(raw))

    const security2 = await import(`../../src/lib/core/security.mjs?norel2=${Date.now()}`)
    assert.equal(security2.verifyPanelSession(token)?.user, 'admin')
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after[storedKey].exp, raw[storedKey].exp)
  } finally {
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPanelSession skips a second disk write when TTL was just renewed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-security-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  try {
    const security = await import(`../../src/lib/core/security.mjs?twice=${Date.now()}`)
    const token = security.createPanelSession('admin', 60_000)
    const file = path.join(dir, 'panel-sessions.json')

    const security2 = await import(`../../src/lib/core/security.mjs?twice2=${Date.now()}`)
    assert.ok(security2.verifyPanelSession(token))
    const afterFirst = JSON.parse(fs.readFileSync(file, 'utf8'))
    const storedKey = Object.keys(afterFirst)[0]
    const expAfterFirst = afterFirst[storedKey].exp
    const mtimeAfterFirst = fs.statSync(file).mtimeMs

    assert.ok(security2.verifyPanelSession(token))
    const afterSecond = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(afterSecond[storedKey].exp, expAfterFirst)
    assert.equal(fs.statSync(file).mtimeMs, mtimeAfterFirst)
  } finally {
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('existing loose panel session file is tightened on load', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-security-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  const file = path.join(dir, 'panel-sessions.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ 'kin-panel-load': { user: 'admin', role: 'admin', exp: Date.now() + 60_000 } }),
  )
  fs.chmodSync(file, 0o644)
  try {
    const security = await import(`../../src/lib/core/security.mjs?tighten=${Date.now()}`)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(security.verifyPanelSession('kin-panel-load').user, 'admin')
  } finally {
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
