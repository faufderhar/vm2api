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
  const proxied = {
    apiKeyKind: 'master',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.8' },
  }
  assert.equal(masterMayAdminister(proxied, {}), false)
  assert.equal(masterMayAdminister(proxied, { TRUST_PROXY: '1' }), false)
  assert.equal(
    masterMayAdminister(
      {
        apiKeyKind: 'master',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': '203.0.113.8, 127.0.0.1' },
      },
      { TRUST_PROXY: '1' },
    ),
    true,
  )
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
  assert.equal(loginRateLimited(limiter, shared, 'bob', {}), true)
  assert.equal(loginRateLimited(limiter, shared, 'alice', {}), true)
})

test('login limits ignore a client-supplied forwarded address unless the proxy is trusted', async () => {
  const { loginRateLimited, createAttemptLimiter } = await import(
    `../../src/lib/core/security.mjs?forwarded=${Date.now()}`
  )
  const limiter = createAttemptLimiter({ limit: 1, windowMs: 60_000 })
  const alice = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.8, 198.51.100.2' },
  }
  const bob = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.3' },
  }
  assert.equal(loginRateLimited(limiter, alice, 'alice', { TRUST_PROXY: '1' }), false)
  assert.equal(loginRateLimited(limiter, bob, 'bob', { TRUST_PROXY: '1' }), false)
  assert.equal(loginRateLimited(limiter, alice, 'alice', { TRUST_PROXY: '1' }), true)
})

test('a full login limiter does not forget a live account when new names arrive', async () => {
  const { createAttemptLimiter } = await import(`../../src/lib/core/security.mjs?evict=${Date.now()}`)
  const limiter = createAttemptLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 })
  assert.equal(limiter('user:admin'), false)
  assert.equal(limiter('user:admin'), true)
  assert.equal(limiter('user:other'), false)
  // Full: the least-used counter makes room. A full map never refuses everyone.
  assert.equal(limiter('user:another'), false)
  assert.equal(limiter('user:admin'), true)
})

test('failed logins from elsewhere do not lock the account owner out', async () => {
  const { loginRateLimited, recordLoginFailure, createAttemptLimiter } = await import(
    `../../src/lib/core/security.mjs?lockout=${Date.now()}`
  )
  const limiter = createAttemptLimiter({ limit: 3, windowMs: 60_000 })
  const from = (address) => ({ socket: { remoteAddress: address }, headers: {} })
  for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
    assert.equal(loginRateLimited(limiter, from(address), 'admin', {}), false)
    recordLoginFailure(limiter, from(address), 'admin', {})
  }
  // The account is over its limit: clients that failed on it wait, a clean one may try.
  assert.equal(loginRateLimited(limiter, from('198.51.100.1'), 'admin', {}), true)
  assert.equal(loginRateLimited(limiter, from('203.0.113.50'), 'admin', {}), false)
  // Each new address gets one guess, then it is refused too.
  recordLoginFailure(limiter, from('203.0.113.50'), 'admin', {})
  assert.equal(loginRateLimited(limiter, from('203.0.113.50'), 'admin', {}), true)
})

test('a loopback peer is not this machine when the request names a public host or a proxy header', async () => {
  const { isLoopbackRequest } = await import(`../../src/lib/core/security.mjs?host=${Date.now()}`)
  const local = (headers) => ({ socket: { remoteAddress: '127.0.0.1' }, headers })
  assert.equal(isLoopbackRequest(local({ host: '127.0.0.1:8080' }), {}), true)
  assert.equal(isLoopbackRequest(local({ host: 'localhost' }), {}), true)
  assert.equal(isLoopbackRequest(local({ host: '[::1]:8080' }), {}), true)
  assert.equal(isLoopbackRequest(local({}), {}), true)
  // nginx proxy_pass with `proxy_set_header Host $host` and nothing else.
  assert.equal(isLoopbackRequest(local({ host: 'panel.example.com' }), {}), false)
  assert.equal(isLoopbackRequest(local({ host: '127.0.0.1', 'x-real-ip': '203.0.113.8' }), {}), false)
  assert.equal(isLoopbackRequest(local({ host: '127.0.0.1', via: '1.1 proxy' }), {}), false)
})

test('a missing user row only keeps the env admin session', async () => {
  const previousUser = process.env.VM2API_ADMIN_USER
  const previousPassword = process.env.VM2API_ADMIN_PASSWORD
  process.env.VM2API_ADMIN_USER = 'root-admin'
  process.env.VM2API_ADMIN_PASSWORD = 'not-the-default'
  try {
    const { panelSessionAccess } = await import(`../../src/lib/core/security.mjs?missing-user=${Date.now()}`)
    assert.equal(panelSessionAccess({ user: 'root-admin', role: 'user' }, null).role, 'admin')
    assert.equal(panelSessionAccess({ user: 'gone', role: 'admin' }, null).reason, 'user_missing')
    process.env.VM2API_ADMIN_PASSWORD = ''
    assert.equal(panelSessionAccess({ user: 'root-admin', role: 'admin' }, null).reason, 'user_missing')
  } finally {
    if (previousUser == null) delete process.env.VM2API_ADMIN_USER
    else process.env.VM2API_ADMIN_USER = previousUser
    if (previousPassword == null) delete process.env.VM2API_ADMIN_PASSWORD
    else process.env.VM2API_ADMIN_PASSWORD = previousPassword
  }
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

test('an unknown panel token rereads the session file only after it changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-reload-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  const file = path.join(dir, 'panel-sessions.json')
  const realRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = (target, ...rest) => {
    if (target === file) reads += 1
    return realRead.call(fs, target, ...rest)
  }
  try {
    // Two module instances stand in for two processes sharing one data dir.
    const issuer = await import(`../../src/lib/core/security.mjs?reload-a=${Date.now()}`)
    const reader = await import(`../../src/lib/core/security.mjs?reload-b=${Date.now()}`)
    const token = issuer.createPanelSession('admin', 60_000)
    assert.equal(reader.verifyPanelSession(token).user, 'admin')

    reads = 0
    for (let i = 0; i < 5; i++) assert.equal(reader.verifyPanelSession(`kin-panel-unknown-${i}`), null)
    assert.equal(reads, 0)

    const later = issuer.createPanelSession('admin', 60_000)
    assert.equal(reader.verifyPanelSession(later).user, 'admin')
    assert.equal(reads, 1)
  } finally {
    fs.readFileSync = realRead
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed cookie escape does not fail panel token extraction', async () => {
  const { extractPanelToken } = await import(`../../src/lib/core/security.mjs?cookie-escape=${Date.now()}`)
  assert.equal(
    extractPanelToken({ headers: { cookie: 'other=%E0%A4%A; kin_panel_token=kin-panel-abc' } }),
    'kin-panel-abc',
  )
  assert.equal(extractPanelToken({ headers: { cookie: 'kin_panel_token=%ZZ' } }), '%ZZ')
})

test('the client address trusts X-Forwarded-For only behind a declared proxy, and only its last hop', async () => {
  const { requestClientAddress } = await import(`../../src/lib/core/security.mjs?client-addr=${Date.now()}`)
  const req = { socket: { remoteAddress: '10.0.0.9' }, headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } }
  assert.equal(requestClientAddress(req, {}), '10.0.0.9')
  assert.equal(requestClientAddress(req, { TRUST_PROXY: '1' }), '203.0.113.7')
  assert.equal(
    requestClientAddress({ socket: { remoteAddress: '10.0.0.9' }, headers: {} }, { TRUST_PROXY: '1' }),
    '10.0.0.9',
  )
})

test('https PUBLIC_BASE_URL sets Secure, and a short env admin password is refused', async () => {
  const {
    panelCookieSecure,
    panelSessionCookieOptions,
    panelSessionCookie,
    warnPanelCookieScheme,
    assertEnvAdminPassword,
  } = await import(`../../src/lib/core/security.mjs?cookie-https=${Date.now()}`)
  assert.equal(panelCookieSecure({}, { PUBLIC_BASE_URL: 'https://console.example', PUBLIC_SCHEME: 'http' }), true)
  const warnings = []
  warnPanelCookieScheme({}, (line) => warnings.push(line))
  assert.equal(warnings.length, 1)
  warnPanelCookieScheme({ PUBLIC_SCHEME: 'http' }, (line) => warnings.push(line))
  assert.equal(warnings.length, 1)
  assert.throws(() => assertEnvAdminPassword('short'), /8/)
  assert.throws(() => assertEnvAdminPassword(''), /must be set/)
  assert.throws(() => assertEnvAdminPassword('123456'), /123456/)
  assert.equal(assertEnvAdminPassword('long-enough'), 'long-enough')

  const cross = panelSessionCookieOptions(
    { headers: { host: 'api.example.com', origin: 'https://panel.other.test' } },
    new Set(['https://panel.other.test']),
    { PUBLIC_SCHEME: 'https' },
  )
  assert.deepEqual(cross, { sameSite: 'None', secure: true })
  const cookie = panelSessionCookie('kin-panel-test', cross)
  assert.match(cookie, /SameSite=None/)
  assert.match(cookie, /Secure/)
  const same = panelSessionCookieOptions(
    { headers: { host: 'api.example.com', origin: 'https://console.example.com' } },
    new Set(['https://console.example.com']),
    { PUBLIC_SCHEME: 'https' },
  )
  assert.equal(same.sameSite, 'Lax')
})

test('a full rate-limit map does not reset an empty bucket', async () => {
  const { createRateLimiter } = await import(`../../src/lib/core/security.mjs?limit=${Date.now()}`)
  const allow = createRateLimiter({ capacity: 1, refillPerSec: 0, maxKeys: 1 })
  assert.equal(allow('spent'), true)
  assert.equal(allow('spent'), false)
  assert.equal(allow('fresh'), false)
  assert.equal(allow('spent'), false)

  const roomy = createRateLimiter({ capacity: 2, refillPerSec: 0, maxKeys: 1 })
  assert.equal(roomy('kept'), true)
  assert.equal(roomy('newcomer'), true)
  assert.equal(roomy('kept'), true)
})

test('a password check lasts five minutes and a wrong password keeps the session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-step-'))
  const previous = process.env.KIN_DATA_DIR
  process.env.KIN_DATA_DIR = dir
  try {
    const { createPanelSession, consumePanelStepUp, verifyPanelSession, revokePanelSession } = await import(
      `../../src/lib/core/security.mjs?step=${Date.now()}`
    )
    const token = createPanelSession('ada', { role: 'admin' })
    const req = { headers: { authorization: `Bearer ${token}` }, panelUser: 'ada' }
    const denied = await consumePanelStepUp(req, 'nope', async () => null)
    assert.equal(denied.ok, false)
    assert.equal(verifyPanelSession(token).user, 'ada')
    const ok = await consumePanelStepUp(req, 'right', async (user, password) =>
      password === 'right' ? { username: user } : null,
    )
    assert.equal(ok.ok, true)
    const again = await consumePanelStepUp(req, '', async () => {
      throw new Error('should not ask again')
    })
    assert.equal(again.fresh, true)
    revokePanelSession(token)
  } finally {
    if (previous == null) delete process.env.KIN_DATA_DIR
    else process.env.KIN_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
