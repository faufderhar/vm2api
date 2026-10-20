import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import {
  enrichCodexAccountIdentity,
  parseCodexCredentialInput,
  readCodexAccounts,
  summarizeCodexSlot,
  upsertCodexAccount,
  writeCodexAccounts,
} from '../../src/lib/vm/codex-slot.mjs'

test('parseCodexCredentialInput accepts Codex CLI auth.json', () => {
  const parsed = parseCodexCredentialInput({
    tokens: {
      access_token: 'eyJhbGciOiaccess',
      refresh_token: 'rt-1',
      id_token: 'id-1',
    },
    account_id: 'acc-uuid',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'eyJhbGciOiaccess')
  assert.equal(parsed.account.refresh_token, 'rt-1')
  assert.equal(parsed.account.chatgpt_account_id, 'acc-uuid')
})

test('parseCodexCredentialInput accepts kernel accounts file', () => {
  const parsed = parseCodexCredentialInput(
    JSON.stringify({
      accounts: [
        {
          id: 'user@example.com',
          access_token: 'at',
          refresh_token: 'rt',
          chatgpt_account_id: 'org-1',
        },
      ],
    }),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.email, 'user@example.com')
  assert.equal(parsed.account.chatgpt_account_id, 'org-1')
})

test('parseCodexCredentialInput rejects Claude sessionKey JSON', () => {
  const parsed = parseCodexCredentialInput({ session_key: 'sk-ant-sid01-xxx' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'missing_token')
})

test('parseCodexCredentialInput accepts AT-only paste', () => {
  const parsed = parseCodexCredentialInput('eyJhbGciOiaccess', { mode: 'access_token' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'eyJhbGciOiaccess')
  assert.equal(parsed.account.refresh_token, '')
})

test('parseCodexCredentialInput accepts RT-only paste', () => {
  const parsed = parseCodexCredentialInput('rt-only-1\nrt-ignored', { mode: 'refresh_token' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.refresh_token, 'rt-only-1')
  assert.equal(parsed.account.access_token, '')
  assert.equal(parsed.extra_count, 1)
})

test('parseCodexCredentialInput accepts camelCase credentials object', () => {
  const parsed = parseCodexCredentialInput({
    credentials: { accessToken: 'at-2', refreshToken: 'rt-2', idToken: 'id-2' },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'at-2')
  assert.equal(parsed.account.refresh_token, 'rt-2')
})

test('parseCodexCredentialInput accepts CPR openai document', () => {
  const parsed = parseCodexCredentialInput({
    documents: [
      { provider: 'xai', document: { refreshToken: 'xai-rt' } },
      { provider: 'openai', document: { accounts: [{ accessToken: 'cpr-at', refreshToken: 'cpr-rt' }] } },
    ],
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'cpr-at')
  assert.equal(parsed.account.refresh_token, 'cpr-rt')
})

test('parseCodexCredentialInput rejects OPENAI_API_KEY-only client config', () => {
  const parsed = parseCodexCredentialInput({ OPENAI_API_KEY: 'sk-proj-not-oauth' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'not_oauth_account')
})

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.sig`
}

test('credential imports resolve explicit email, id_token, then access_token', () => {
  const idToken = jwt({ 'https://api.openai.com/profile': { email: 'id@example.com' } })
  const accessToken = jwt({
    email: 'access@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-jwt' },
  })
  const auth = { tokens: { id_token: idToken, access_token: accessToken, refresh_token: 'rt' } }
  assert.equal(
    parseCodexCredentialInput({ ...auth, email: 'explicit@example.com' }).account.email,
    'explicit@example.com',
  )
  const parsed = parseCodexCredentialInput(JSON.stringify(auth))
  assert.equal(parsed.account.email, 'id@example.com')
  assert.equal(parsed.account.id, 'id@example.com')
  assert.equal(parsed.account.chatgpt_account_id, 'acc-jwt')
  const accessOnly = parseCodexCredentialInput(accessToken, { mode: 'access_token' })
  assert.equal(accessOnly.account.email, 'access@example.com')
  assert.equal(accessOnly.account.access_token, accessToken)
})

test('CPR camelCase tokens resolve identity without treating opaque ids as emails', () => {
  const parsed = parseCodexCredentialInput({
    documents: [
      {
        provider: 'openai',
        document: {
          accounts: [
            {
              id: 'codex',
              credentials: {
                idToken: jwt({ email: 'cpr@example.com' }),
                accessToken: 'opaque-at',
                refreshToken: 'rt',
              },
            },
          ],
        },
      },
    ],
  })
  assert.equal(parsed.account.email, 'cpr@example.com')
  for (const token of ['opaque-at', 'header.invalid.sig', jwt({ sub: 'user-id' })]) {
    const unknown = parseCodexCredentialInput({ id: 'user-id', access_token: token })
    assert.equal(unknown.ok, true)
    assert.equal(unknown.account.email, null)
  }
  assert.equal(parseCodexCredentialInput('rt-only', { mode: 'refresh_token' }).account.email, null)
})

test('legacy credentials show token identity on read without rewriting the credential file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-legacy-id-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vmId = 'vm-01'
  const dir = path.join(root, 'vms', vmId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'codex-credentials.json')
  const raw = JSON.stringify({
    accounts: [
      {
        id: 'codex',
        access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'legacy-acc' } }),
        id_token: jwt({ 'https://api.openai.com/profile': { email: 'legacy@example.com' } }),
      },
    ],
  })
  fs.writeFileSync(file, raw)
  const summary = summarizeCodexSlot(root, { id: vmId, platform: 'openai', codex: {} })
  assert.equal(summary.email, 'legacy@example.com')
  assert.equal(summary.has_token, true)
  assert.equal(summary.chatgpt_account_id, 'legacy-acc')
  assert.equal(fs.readFileSync(file, 'utf8'), raw)
  assert.equal(readCodexAccounts(root, vmId)[0].email, undefined)
})

test('slot summaries keep account ids separate from missing emails', () => {
  const summary = summarizeCodexSlot(null, {
    id: 'vm-01',
    codex: { has_refresh: true, chatgpt_account_id: 'account-uuid' },
  })
  assert.equal(summary.has_token, true)
  assert.equal(summary.email, null)
  assert.equal(summary.chatgpt_account_id, 'account-uuid')
})

test('all credential writers persist token identity without changing tokens or account ids', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-write-id-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-01'), { recursive: true })
  const accessToken = jwt({ 'https://api.openai.com/profile': { email: 'written@example.com' } })
  writeCodexAccounts(root, 'vm-01', [{ id: 'stable-id', access_token: accessToken, refresh_token: 'rt' }])
  const saved = readCodexAccounts(root, 'vm-01')[0]
  assert.equal(saved.email, 'written@example.com')
  assert.equal(saved.id, 'stable-id')
  assert.equal(saved.access_token, accessToken)
  assert.equal(saved.refresh_token, 'rt')
})

test('refresh preserves explicit identity while credential replacement clears the old account', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-replace-id-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-01'), { recursive: true })
  upsertCodexAccount(root, 'vm-01', {
    id: 'old-id',
    email: 'explicit@example.com',
    chatgpt_account_id: 'old-acc',
    id_token: jwt({ email: 'old@example.com' }),
    access_token: 'old-at',
    refresh_token: 'old-rt',
    expires_at: 123,
    max_concurrency: 4,
  })
  const refreshed = upsertCodexAccount(root, 'vm-01', { access_token: 'new-at', refresh_token: 'new-rt' })
  assert.equal(refreshed.email, 'explicit@example.com')
  assert.equal(refreshed.chatgpt_account_id, 'old-acc')
  const replacement = upsertCodexAccount(root, 'vm-01', { refresh_token: 'other-rt' }, { replaceCredentials: true })
  assert.equal(replacement.email, null)
  assert.equal(replacement.chatgpt_account_id, null)
  assert.equal(replacement.id, 'codex')
  assert.equal(replacement.id_token, undefined)
  assert.equal(replacement.access_token, undefined)
  assert.equal(replacement.expires_at, undefined)
  assert.equal(replacement.max_concurrency, 4)
  const identified = upsertCodexAccount(
    root,
    'vm-01',
    {
      access_token: 'other-at',
      id_token: jwt({ email: 'other@example.com' }),
    },
    { replaceCredentials: true },
  )
  assert.equal(identified.email, 'other@example.com')
  assert.equal(identified.id, 'other@example.com')
})

test('panel import replaces credentials and returns the current account email', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-panel-id-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vmId = 'vm-01'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  const vmFile = path.join(root, 'vms', `${vmId}.json`)
  fs.writeFileSync(
    vmFile,
    JSON.stringify({
      id: vmId,
      platform: 'openai',
      family: 'codex',
      codex: { email: 'old@example.com', has_access: true, has_refresh: true },
    }),
  )
  upsertCodexAccount(root, vmId, {
    email: 'old@example.com',
    access_token: 'old-at',
    refresh_token: 'old-rt',
    id_token: jwt({ email: 'old@example.com' }),
  })
  for (const [token, expectedEmail] of [
    [jwt({ email: 'new@example.com' }), 'new@example.com'],
    ['opaque-at', null],
  ]) {
    let status
    let response
    const handlePanel = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: { codex: { catalog_client_version: '0.160.0' } },
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      readBody: async () => ({ vm_id: vmId, mode: 'access_token', raw: token }),
      json(_res, code, body) {
        status = code
        response = body
        return true
      },
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/import'))
    assert.equal(status, 200)
    assert.equal(response.data.vm.email, expectedEmail)
    assert.equal(response.data.vm.has_token, true)
    const saved = readCodexAccounts(root, vmId)[0]
    assert.equal(saved.email, expectedEmail)
    assert.equal(saved.access_token, token)
    assert.equal(saved.refresh_token, '')
    assert.equal(saved.id_token, '')
    assert.equal(JSON.parse(fs.readFileSync(vmFile, 'utf8')).codex.email, expectedEmail)
  }
})

test('enrichCodexAccountIdentity extracts email from OAuth id_token', () => {
  const idToken = jwt({ email: 'gpt-user@example.com', sub: 'sub-1' })
  const accessToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-acc-9' },
  })
  const enriched = enrichCodexAccountIdentity({
    access_token: accessToken,
    refresh_token: 'rt',
    id_token: idToken,
  })
  assert.equal(enriched.email, 'gpt-user@example.com')
  assert.equal(enriched.chatgpt_account_id, 'chatgpt-acc-9')
})

test('upsertCodexAccount persists identity for panel summarizeCodexSlot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-oauth-id-'))
  const vmId = 'vm-codex-oauth'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  const idToken = jwt({ email: 'panel@example.com' })
  upsertCodexAccount(root, vmId, {
    access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-panel' } }),
    refresh_token: 'rt',
    id_token: idToken,
  })
  const summary = summarizeCodexSlot(root, {
    id: vmId,
    platform: 'openai',
    family: 'codex',
    codex: { has_access: true },
  })
  assert.equal(summary.email, 'panel@example.com')
  assert.equal(summary.chatgpt_account_id, 'acc-panel')
  assert.equal(summary.chatgpt_subscription_active_until, null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('enrichCodexAccountIdentity overwrites subscription expiry when refresh id_token carries claim', () => {
  const oldUntil = '2026-01-01T00:00:00Z'
  const newUntil = '2027-02-02T00:00:00Z'
  const enriched = enrichCodexAccountIdentity({
    chatgpt_subscription_active_until: oldUntil,
    id_token: jwt({ chatgpt_subscription_active_until: newUntil }),
  })
  assert.equal(enriched.chatgpt_subscription_active_until, newUntil)
})

test('enrichCodexAccountIdentity retains subscription expiry when refresh id_token omits claim', () => {
  const oldUntil = '2026-06-01T00:00:00Z'
  const enriched = enrichCodexAccountIdentity({
    chatgpt_subscription_active_until: oldUntil,
    id_token: jwt({ email: 'user@example.com' }),
  })
  assert.equal(enriched.chatgpt_subscription_active_until, oldUntil)
})

test('upsertCodexAccount refresh updates subscription expiry from new id_token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sub-refresh-'))
  const vmId = 'vm-codex-refresh-sub'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  upsertCodexAccount(root, vmId, {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    id_token: jwt({ chatgpt_subscription_active_until: '2025-01-01T00:00:00Z' }),
  })
  const refreshed = upsertCodexAccount(root, vmId, {
    access_token: 'at-2',
    refresh_token: 'rt-2',
    id_token: jwt({ chatgpt_subscription_active_until: '2029-05-05T00:00:00Z' }),
  })
  assert.equal(refreshed.chatgpt_subscription_active_until, '2029-05-05T00:00:00Z')
  fs.rmSync(root, { recursive: true, force: true })
})

test('summarizeCodexSlot exposes chatgpt_subscription_active_until from id_token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sub-until-'))
  const vmId = 'vm-codex-sub'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  const until = '2028-03-15T08:00:00Z'
  upsertCodexAccount(root, vmId, {
    access_token: 'at',
    refresh_token: 'rt',
    id_token: jwt({ chatgpt_subscription_active_until: until }),
  })
  const summary = summarizeCodexSlot(root, { id: vmId, platform: 'openai', codex: {} })
  assert.equal(summary.chatgpt_subscription_active_until, until)
  fs.rmSync(root, { recursive: true, force: true })
})

test('enrichCodexAccountIdentity does not crash on invalid jwt', () => {
  const enriched = enrichCodexAccountIdentity({ access_token: 'bad-token', id_token: 'also-bad' })
  assert.equal(enriched.email, null)
  assert.equal(enriched.chatgpt_account_id, null)
})

test('upsertCodexAccount writes credential file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-slot-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-codex-01'), { recursive: true })
  upsertCodexAccount(root, 'vm-codex-01', {
    access_token: 'at',
    refresh_token: 'rt',
    chatgpt_account_id: 'org-9',
  })
  const accounts = readCodexAccounts(root, 'vm-codex-01')
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].access_token, 'at')
  assert.equal(accounts[0].chatgpt_account_id, 'org-9')
  fs.rmSync(root, { recursive: true, force: true })
})

test('imported Codex account defaults to unlimited kernel concurrency', () => {
  const parsed = parseCodexCredentialInput({
    tokens: { access_token: 'at', refresh_token: 'rt' },
    account_id: 'acc-uuid',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.max_concurrency, 0)
  assert.equal(parsed.account.rpm, 0)
})
