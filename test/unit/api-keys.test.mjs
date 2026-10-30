import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore, generateApiKey, maskApiKey } from '../../src/lib/admin/api-keys.mjs'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  return new ApiKeyStore({ dataDir: dir })
}

test('generateApiKey uses sk-vm- prefix and is long enough', () => {
  const k = generateApiKey()
  assert.match(k, /^sk-vm-[a-f0-9]{64}$/)
  assert.notEqual(k, generateApiKey())
})

test('maskApiKey hides middle', () => {
  const k = 'sk-vm-' + 'a'.repeat(64)
  const m = maskApiKey(k)
  assert.ok(m.includes('…'))
  assert.ok(!m.includes('a'.repeat(20)))
})

test('create + authenticate + list mask', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'demo', max_concurrency: 3, quota_requests: 10, rpm: 60 })
  assert.equal(rec.name, 'demo')
  assert.equal(rec.max_concurrency, 3)
  assert.equal(rec.quota_requests, 10)
  const auth = store.authenticate(rec.key)
  assert.equal(auth.ok, true)
  assert.equal(auth.record.id, rec.id)
  const stored = store.getById(rec.id)
  assert.notEqual(stored.key, rec.key)
  assert.match(stored.key, /^hmac:/)
  assert.ok(stored.key_hash)
  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.ok(listed[0].key.includes('…'))
  assert.notEqual(listed[0].key, rec.key)
})

test('reveal returns the plaintext for copy; rotate swaps it in place', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'copyable', max_concurrency: 4 })
  const listed = store.list()[0]
  assert.equal(listed.revealable, true)
  assert.ok(listed.key.includes('…'), 'list stays masked')

  const shown = store.reveal(rec.id)
  assert.equal(shown.ok, true)
  assert.equal(shown.key, rec.key)

  const rotated = store.rotate(rec.id)
  assert.notEqual(rotated.key, rec.key)
  assert.equal(store.authenticate(rec.key).ok, false, 'old value dies')
  assert.equal(store.authenticate(rotated.key).ok, true)
  assert.equal(store.reveal(rec.id).key, rotated.key)
  const kept = store.getById(rec.id)
  assert.equal(kept.name, 'copyable')
  assert.equal(kept.max_concurrency, 4)
})

test('reveal reports hash-only rows as unrecoverable', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'legacy' })
  const row = store.getById(rec.id)
  row.key_secret = null
  store.repo.update(row)

  const out = store.reveal(rec.id)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'key_not_recoverable')
  assert.equal(store.list()[0].revealable, false)
  assert.equal(store.reveal('key_missing'), null)
  assert.equal(store.authenticate(rec.key).ok, true, 'auth still works off the hash')
})

test('a plaintext legacy row still migrates, and wrong keys stop scanning once none is left', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'plaintext' })
  const row = store.getById(rec.id)
  row.key = rec.key
  row.key_hash = 'legacy-unhashed'
  store.repo.update(row)
  let scans = 0
  const list = store.repo.list.bind(store.repo)
  store.repo.list = (...args) => {
    scans += 1
    return list(...args)
  }

  assert.equal(store.authenticate('sk-vm-wrong-1').ok, false)
  assert.equal(store.authenticate(rec.key).ok, true)
  assert.match(store.getById(rec.id).key, /^hmac:/)

  scans = 0
  for (let i = 0; i < 5; i++) assert.equal(store.authenticate(`sk-vm-wrong-${i}`).ok, false)
  assert.equal(scans, 1)
  assert.equal(store.authenticate(rec.key).ok, true)
})

test('the public pepper upgrades only keys created before this data dir recorded the cutoff', () => {
  const store = tmpStore()
  const oldKey = store.create({ name: 'old-pepper' })
  const oldRow = store.getById(oldKey.id)
  oldRow.created_at = new Date(store.legacyCutoff - 60_000).toISOString()
  oldRow.key_hash = store._hashWith(oldKey.key, 'kin-development-api-key-hash-secret')
  oldRow.key = `hmac:${oldRow.key_hash}`
  store.repo.update(oldRow)
  assert.equal(store.authenticate(oldKey.key).ok, true)

  const freshKey = store.create({ name: 'planted-pepper' })
  const planted = store.getById(freshKey.id)
  planted.key_hash = store._hashWith(freshKey.key, 'kin-development-api-key-hash-secret')
  planted.key = `hmac:${planted.key_hash}`
  store.repo.update(planted)
  assert.equal(store.authenticate(freshKey.key).ok, false)
})

test('key_secret is encrypted at rest when KIN_DB_SECRET is set', () => {
  const prev = process.env.KIN_DB_SECRET
  process.env.KIN_DB_SECRET = 'unit-test-secret'
  try {
    const store = tmpStore()
    const rec = store.create({ name: 'enc' })
    const row = store.getById(rec.id)
    assert.match(row.key_secret, /^enc:v1:/)
    assert.ok(!row.key_secret.includes(rec.key))
    assert.equal(store.reveal(rec.id).key, rec.key)
  } finally {
    if (prev === undefined) delete process.env.KIN_DB_SECRET
    else process.env.KIN_DB_SECRET = prev
  }
})

test('canAccept rejects disabled / expired / quota / concurrency', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'lim', max_concurrency: 1, quota_requests: 2, rpm: 0 })
  assert.equal(store.canAccept(rec).ok, true)

  store.update(rec.id, { status: 'disabled' })
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_disabled')
  store.update(rec.id, { status: 'active' })

  store.update(rec.id, { expires_at: new Date(Date.now() - 1000).toISOString() })
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_expired')
  store.update(rec.id, { expires_at: null })

  const a = store.acquire(store.getById(rec.id))
  assert.equal(a.ok, true)
  const blocked = store.canAccept(store.getById(rec.id))
  assert.equal(blocked.code, 'api_key_concurrency_limit')
  store.release(rec.id)

  store.recordUsage(rec.id)
  store.recordUsage(rec.id)
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_quota_exhausted')
})

test('rpm window blocks then recovers', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'rpm', max_concurrency: 0, quota_requests: 0, rpm: 2 })
  assert.equal(store.acquire(rec).ok, true)
  store.release(rec)
  assert.equal(store.acquire(rec).ok, true)
  store.release(rec)
  const gate = store.canAccept(store.getById(rec.id))
  assert.equal(gate.code, 'api_key_rate_limit')
})

test('user concurrency caps regular users but never the admin operator', () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  for (const [id, role] of [
    ['u-admin', 'admin'],
    ['u-user', 'user'],
  ]) {
    store.users.insert({ id, username: id, password_hash: 'x', role, concurrency: 1, created_at: now, updated_at: now })
  }
  const admin = store.create({ name: 'admin-key', max_concurrency: 0, user_id: 'u-admin' })
  const user = store.create({ name: 'user-key', max_concurrency: 0, user_id: 'u-user' })

  for (let i = 0; i < 3; i++) assert.equal(store.acquire(admin).ok, true)

  assert.equal(store.acquire(user).ok, true)
  const blocked = store.canAccept(user)
  assert.equal(blocked.code, 'user_concurrency_limit')
  assert.deepEqual(blocked.detail, { inflight: 1, max: 1 })
})

test('update reset_quota and remove', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'x', quota_requests: 5 })
  store.recordUsage(rec.id)
  store.recordUsage(rec.id)
  assert.equal(store.getById(rec.id).quota_requests_used, 2)
  store.update(rec.id, { reset_quota: true })
  assert.equal(store.getById(rec.id).quota_requests_used, 0)
  assert.equal(store.remove(rec.id), true)
  assert.equal(store.getById(rec.id), null)
  assert.equal(store.authenticate(rec.key).ok, false)
})

test('recordUsage accumulates cache token columns', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'cache' })
  store.recordUsage(rec.id, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 7,
  })
  store.recordUsage(rec.id, { input_tokens: 1, output_tokens: 1, cache_read_tokens: 2 })
  const saved = store.getById(rec.id)
  assert.equal(saved.tokens_in, 11)
  assert.equal(saved.tokens_out, 6)
  assert.equal(saved.cache_read_tokens, 5)
  assert.equal(saved.cache_creation_tokens, 7)
})

test('spend windows add in SQL and a closed window starts over', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'win', quota: 10 })
  store.recordUsage(rec.id, {}, { officialCost: 1.5 })
  store.recordUsage(rec.id, {}, { officialCost: 2.5 })
  let saved = store.getById(rec.id)
  assert.equal(saved.usage_5h, 4)
  assert.equal(saved.usage_1d, 4)
  assert.equal(saved.usage_7d, 4)
  assert.equal(saved.quota_used, 4)
  const stale = new Date(Date.now() - 6 * 3600 * 1000).toISOString()
  store.db.prepare('UPDATE api_keys SET window_5h_start = ? WHERE id = ?').run(stale, rec.id)
  store.recordUsage(rec.id, {}, { officialCost: 0.5 })
  saved = store.getById(rec.id)
  assert.equal(saved.usage_5h, 0.5)
  assert.equal(saved.usage_1d, 4.5)
  assert.equal(saved.status, 'active')
  store.recordUsage(rec.id, {}, { officialCost: 6 })
  saved = store.getById(rec.id)
  assert.equal(saved.quota_used, 10.5)
  assert.equal(saved.status, 'quota_exhausted')
})

test('user concurrency sums keys in memory and releases by id', () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  store.users.insert({
    id: 'u-two',
    username: 'u-two',
    password_hash: 'x',
    role: 'user',
    concurrency: 2,
    created_at: now,
    updated_at: now,
  })
  const first = store.create({ name: 'one', max_concurrency: 0, user_id: 'u-two' })
  const second = store.create({ name: 'two', max_concurrency: 0, user_id: 'u-two' })
  assert.equal(store.acquire(first).ok, true)
  assert.equal(store.acquire(second).ok, true)
  assert.equal(store.canAccept(first).code, 'user_concurrency_limit')
  store.release(first.id)
  assert.equal(store.canAccept(second).ok, true)
  store.release(second)
  assert.equal(store.userInflight.get('u-two'), undefined)
})

test('a key moved to another user mid-flight gives each owner its slots back', () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  for (const id of ['u-from', 'u-to']) {
    store.users.insert({
      id,
      username: id,
      password_hash: 'x',
      role: 'user',
      concurrency: 1,
      created_at: now,
      updated_at: now,
    })
  }
  const key = store.create({ name: 'moved', max_concurrency: 0, user_id: 'u-from' })
  const sibling = store.create({ name: 'sibling', max_concurrency: 0, user_id: 'u-from' })
  const before = store.getById(key.id)
  assert.equal(store.acquire(before).ok, true)
  const after = store.update(key.id, { user_id: 'u-to' })
  assert.equal(store.acquire(after).ok, true)
  assert.equal(store.userInflight.get('u-from'), 1)
  assert.equal(store.userInflight.get('u-to'), 1)
  store.release(after)
  assert.equal(store.userInflight.get('u-to'), undefined)
  assert.equal(store.canAccept(sibling).code, 'user_concurrency_limit')
  store.release(before)
  assert.equal(store.userInflight.get('u-from'), undefined)
  assert.equal(store.canAccept(sibling).ok, true)

  // Bare-id releases: once the key has nothing in flight, no owner keeps a slot.
  const back = store.update(key.id, { user_id: 'u-from' })
  assert.equal(store.acquire(back).ok, true)
  assert.equal(store.acquire(store.update(key.id, { user_id: 'u-to' })).ok, true)
  store.release(key.id)
  store.release(key.id)
  assert.equal(store.userInflight.size, 0)
  assert.equal(store.keyUsers.size, 0)
})

test('recordUsage does not charge a soft-deleted key', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'gone', quota: 10 })
  store.db.prepare('UPDATE api_keys SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), rec.id)
  assert.equal(store.repo.recordUsage(rec.id, { cost: 3 }), null)
  const row = store.db
    .prepare('SELECT requests, quota_used, usage_5h, window_5h_start FROM api_keys WHERE id = ?')
    .get(rec.id)
  assert.equal(row.requests, 0)
  assert.equal(row.quota_used, 0)
  assert.equal(row.usage_5h, 0)
  assert.equal(row.window_5h_start, null)
})

test('spend windows compare starts as time, whatever their text form', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'tz' })
  store.recordUsage(rec.id, {}, { officialCost: 1 })
  const setStart = (start) =>
    store.db.prepare('UPDATE api_keys SET window_5h_start = ? WHERE id = ?').run(start, rec.id)
  // Six hours ago written with a +08:00 offset sorts after the cutoff as text.
  const sixHoursAgo = new Date(Date.now() - 6 * 3600_000 + 8 * 3600_000).toISOString().replace('Z', '+08:00')
  setStart(sixHoursAgo)
  store.recordUsage(rec.id, {}, { officialCost: 2 })
  assert.equal(store.getById(rec.id).usage_5h, 2)
  // An hour ago without milliseconds is still the open window.
  setStart(new Date(Date.now() - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
  store.recordUsage(rec.id, {}, { officialCost: 0.5 })
  assert.equal(store.getById(rec.id).usage_5h, 2.5)
  // A start that does not parse reopens the window, the way canAccept reads it.
  setStart('not-a-date')
  store.recordUsage(rec.id, {}, { officialCost: 4 })
  const saved = store.getById(rec.id)
  assert.equal(saved.usage_5h, 4)
  assert.ok(Number.isFinite(Date.parse(saved.window_5h_start)))
})

test('custom key rejected when duplicate', () => {
  const store = tmpStore()
  store.create({ name: 'a', key: 'sk-kin-customkey0001' })
  assert.throws(() => store.create({ name: 'b', key: 'sk-kin-customkey0001' }), /exists/)
})

test('keys persist in sqlite across store re-open (same dataDir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  const store = new ApiKeyStore({ dataDir: dir })
  const rec = store.create({ name: 'persist', quota_requests: 9 })
  store.recordUsage(rec.id, { input_tokens: 11, output_tokens: 22 })

  const store2 = new ApiKeyStore({ dataDir: dir })
  const again = store2.getById(rec.id)
  assert.ok(again, 'record should survive re-open')
  assert.equal(again.name, 'persist')
  assert.equal(again.quota_requests_used, 1)
  assert.equal(again.tokens_in, 11)
  assert.equal(again.tokens_out, 22)
  assert.equal(store2.authenticate(rec.key).ok, true)
  assert.ok(fs.existsSync(path.join(dir, 'kin.db')), 'kin.db file exists')
})

test('group_type all is the default and a platform group keeps its VM list', () => {
  const store = tmpStore()
  const open = store.create({ name: 'global' })
  assert.equal(store.list()[0].group_type, 'all')
  assert.deepEqual(store.list()[0].allowed_vms, [])
  const scoped = store.create({ name: 'claude', group_type: 'anthropic', allowed_vms: ['vm-01', 'vm-03'] })
  assert.equal(store.getById(scoped.id).group_type, 'anthropic')
  assert.equal(
    store
      .list()
      .find((k) => k.id === scoped.id)
      .allowed_vms.join(','),
    'vm-01,vm-03',
  )
  const widened = store.update(scoped.id, { group_type: 'all' })
  assert.equal(widened.group_type, 'all')
  assert.equal(widened.allowed_vms, '[]')
  assert.throws(() => store.create({ name: 'bare', group_type: 'openai' }), /至少勾选一台 VM/)
  store.update(open.id, { status: 'disabled' })
  assert.equal(store.getById(open.id).group_type, 'all')
})
