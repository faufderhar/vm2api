import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  normalizeNotifyConfig,
  mergeNotifyConfig,
  publicNotifyConfig,
  publicRoutingNotify,
  summarizePoolAvailability,
  detectPoolNotifyEvents,
  DEFAULT_NOTIFY,
  formatNotifyMessage,
  notifyChannelsReady,
  sendEmailNotify,
  smtpDataText,
  sendTelegramNotify,
  sendWecomNotify,
  wecomWebhookUrl,
  dispatchNotify,
  sendNotifyTest,
  createNotifyMonitor,
  SECRET_KEEP,
} from '../../src/lib/admin/notify.mjs'

test('normalize fills defaults and clamps', () => {
  const n = normalizeNotifyConfig({ interval_sec: 3, min_available: 0, email: { port: 0 } })
  assert.equal(n.enabled, false)
  assert.equal(n.interval_sec, 15)
  assert.equal(n.min_available, 1)
  assert.equal(n.digest_sec, 21600)
  assert.equal(n.email.port, 587)
  assert.equal(n.events.pool_empty, true)
  assert.equal(n.events.digest, true)
  assert.equal(n.events.revoked, true)
  assert.equal(n.events.invalid, true)
  assert.equal(n.events.account_down, false)
})

test('465 defaults to implicit TLS', () => {
  const n = normalizeNotifyConfig({ email: { port: 465 } })
  assert.equal(n.email.secure, true)
  assert.equal(normalizeNotifyConfig({ email: { port: 587 } }).email.secure, false)
})

test('merge keeps secrets when the panel sends empty or mask', () => {
  const prev = normalizeNotifyConfig({
    email: { enabled: true, host: 'smtp.example', to: 'a@x.com', pass: 'old-pass' },
    telegram: { enabled: true, bot_token: '123:secret', chat_id: '9' },
  })
  const merged = mergeNotifyConfig(prev, {
    enabled: true,
    email: { enabled: true, host: 'smtp.example', to: 'a@x.com', pass: '' },
    telegram: { enabled: true, bot_token: SECRET_KEEP, chat_id: '9' },
  })
  assert.equal(merged.email.pass, 'old-pass')
  assert.equal(merged.telegram.bot_token, '123:secret')
  const pub = publicNotifyConfig(merged)
  assert.equal(pub.email.pass, '')
  assert.equal(pub.email.pass_set, true)
  assert.equal(pub.telegram.bot_token, '')
  assert.equal(pub.telegram.bot_token_set, true)
})

test('publicRoutingNotify redacts notify secrets and keeps routing fields', () => {
  const pub = publicRoutingNotify({
    concurrency: 4,
    notify: {
      enabled: true,
      email: { enabled: true, host: 'smtp.example', to: 'a@x.com', pass: 'old-pass' },
      telegram: { enabled: true, bot_token: '123:secret', chat_id: '9' },
    },
  })
  assert.equal(pub.concurrency, 4)
  assert.equal(pub.notify.email.pass, '')
  assert.equal(pub.notify.email.pass_set, true)
  assert.equal(pub.notify.telegram.bot_token, '')
  assert.equal(pub.notify.telegram.bot_token_set, true)
})

test('summarize matches overview usable口径', () => {
  const now = Date.parse('2026-08-24T12:00:00+08:00')
  const snap = summarizePoolAvailability(
    [
      { id: 'vm-01', email: 'a@x', has_token: true, status: 'running', cred_status: { key: 'ok', text: '可用' } },
      {
        id: 'vm-02',
        email: 'b@x',
        has_token: true,
        status: 'running',
        cred_status: { key: 'quota', text: '5h 限制' },
        availability: { key: 'quota', text: '5h 限制', usable: true, accept: false },
      },
      { id: 'vm-03', has_token: true, status: 'running', cred_status: { key: 'bad', text: '不可用' } },
      {
        id: 'vm-04',
        has_token: true,
        status: 'running',
        cred_status: { key: 'bad', text: '已吊销' },
        availability: { usable: false, reason: 'invalid_grant', probed_at: '2026-08-24T03:10:00.000Z' },
      },
      { id: 'vm-05', has_token: false, cred_status: { key: 'none', text: '无凭证' } },
    ],
    now,
    { today: { requests: 12, tokens: 3400, total_cost: 1.25, errors: 2, status_429: 1, sla: 0.9 } },
  )
  assert.equal(snap.with_token, 4)
  assert.equal(snap.available, 2)
  assert.equal(snap.unavailable, 2)
  assert.equal(snap.online, 4)
  assert.equal(snap.revoked, 1)
  assert.equal(snap.today_revoked, 1)
  assert.equal(snap.today_unavailable, 1)
  assert.equal(snap.today_invalid, 0)
  assert.equal(snap.invalid, 1)
  assert.equal(snap.today.requests, 12)
  assert.equal(snap.today.errors, 2)
  assert.equal(snap.today.status_429, 1)
})

test('detect pool empty / recover / low', () => {
  const ok = summarizePoolAvailability([
    { id: 'vm-01', has_token: true, cred_status: { key: 'ok', text: '可用' } },
    { id: 'vm-02', has_token: true, cred_status: { key: 'ok', text: '可用' } },
  ])
  const empty = summarizePoolAvailability([
    { id: 'vm-01', has_token: true, cred_status: { key: 'bad', text: '不可用' } },
    { id: 'vm-02', has_token: true, cred_status: { key: 'bad', text: '被吊销' } },
  ])
  const low = summarizePoolAvailability([
    { id: 'vm-01', has_token: true, cred_status: { key: 'ok', text: '可用' } },
    { id: 'vm-02', has_token: true, cred_status: { key: 'bad', text: '不可用' } },
  ])
  const cfg = normalizeNotifyConfig({
    min_available: 2,
    events: { account_down: false, revoked: false, invalid: false },
  })
  assert.deepEqual(
    detectPoolNotifyEvents(ok, empty, cfg).map((e) => e.type),
    ['pool_empty'],
  )
  assert.deepEqual(
    detectPoolNotifyEvents(empty, ok, cfg).map((e) => e.type),
    ['pool_recovered'],
  )
  assert.deepEqual(
    detectPoolNotifyEvents(ok, low, cfg).map((e) => e.type),
    ['pool_low'],
  )
  assert.equal(detectPoolNotifyEvents(null, empty, cfg)[0].type, 'pool_empty')
})

test('detect new revoked and invalid credentials', () => {
  const prev = summarizePoolAvailability([
    { id: 'vm-01', has_token: true, cred_status: { key: 'ok', text: '可用' } },
    { id: 'vm-02', has_token: true, cred_status: { key: 'ok', text: '可用' } },
  ])
  const next = summarizePoolAvailability([
    {
      id: 'vm-01',
      has_token: true,
      cred_status: { key: 'bad', text: '已吊销' },
      availability: { usable: false, reason: 'oauth_revoked' },
    },
    { id: 'vm-02', has_token: true, cred_status: { key: 'bad', text: '无效凭证' } },
  ])
  const cfg = normalizeNotifyConfig({ events: { pool_empty: false, pool_low: false, account_down: false } })
  assert.deepEqual(
    detectPoolNotifyEvents(prev, next, cfg).map((e) => e.type),
    ['revoked', 'invalid'],
  )
})

test('account down only when enabled', () => {
  const prev = summarizePoolAvailability([{ id: 'vm-01', has_token: true, cred_status: { key: 'ok', text: '可用' } }])
  const next = summarizePoolAvailability([
    { id: 'vm-01', email: 'a@x', has_token: true, cred_status: { key: 'bad', text: '不可用' } },
  ])
  const off = normalizeNotifyConfig({
    events: { pool_empty: false, pool_low: false, account_down: false, revoked: false, invalid: false },
  })
  const on = normalizeNotifyConfig({
    events: { pool_empty: false, pool_low: false, account_down: true, revoked: false, invalid: false },
  })
  assert.equal(detectPoolNotifyEvents(prev, next, off).length, 0)
  const ev = detectPoolNotifyEvents(prev, next, on)
  assert.equal(ev[0].type, 'account_down')
  assert.equal(ev[0].id, 'vm-01')
})

test('format message stays Chinese and includes console url', () => {
  const now = Date.parse('2026-08-24T12:00:00+08:00')
  const snap = summarizePoolAvailability(
    [
      { id: 'vm-03', email: 'c@x', has_token: true, cred_status: { key: 'bad', text: '不可用' } },
      {
        id: 'vm-04',
        email: 'd@x',
        has_token: true,
        cred_status: { key: 'bad', text: '无效凭证' },
        availability: { usable: false, probed_at: '2026-08-24T03:10:00.000Z' },
      },
      {
        id: 'vm-05',
        has_token: true,
        cred_status: { key: 'bad', text: '已吊销' },
        availability: { usable: false, reason: 'invalid_grant', probed_at: '2026-08-24T04:00:00.000Z' },
      },
    ],
    now,
  )
  const msg = formatNotifyMessage(
    { type: 'pool_empty', title: '账号池无可用账号' },
    snap,
    DEFAULT_NOTIFY,
    'http://127.0.0.1:8787',
  )
  assert.match(msg.text, /账号池无可用账号/)
  assert.match(msg.text, /凭证 3 · 可用 0/)
  assert.match(msg.text, /不可用 3/)
  assert.match(msg.text, /吊销 1 · 今日吊销 1 · 失效 2 · 今日失效 1/)
  assert.match(msg.text, /今日/)
  assert.match(msg.text, /错误 0 · 429 0/)
  assert.match(msg.text, /今日不可用 \/ 失效/)
  assert.match(msg.text, /vm-05 已吊销/)
  assert.match(msg.text, /vm-04 d@x 无效凭证/)
  assert.doesNotMatch(msg.text, /vm-03 c@x/)
  assert.doesNotMatch(msg.text, /^不可用$/m)
  assert.match(msg.text, /http:\/\/127\.0\.0\.1:8787\/#\/cluster/)
  const custom = formatNotifyMessage(
    { type: 'pool_empty' },
    snap,
    normalizeNotifyConfig({ console_url: 'https://panel.example/' }),
    'http://127.0.0.1:8787',
  )
  assert.match(custom.text, /https:\/\/panel\.example\/#\/cluster/)
  assert.doesNotMatch(formatNotifyMessage({ type: 'pool_empty' }, snap).text, /#\/cluster/)
  assert.match(msg.subject, /KIN/)
})

test('format lists only first 5 today issues and a leftover count', () => {
  const now = Date.parse('2026-08-24T12:00:00+08:00')
  const vms = Array.from({ length: 7 }, (_, i) => ({
    id: `vm-0${i + 1}`,
    has_token: true,
    cred_status: { key: 'bad', text: '无效凭证' },
    availability: { usable: false, probed_at: '2026-08-24T03:00:00.000Z' },
  }))
  const snap = summarizePoolAvailability(vms, now)
  const msg = formatNotifyMessage({ type: 'digest', title: '账号池汇报', ids: vms.map((v) => v.id), count: 7 }, snap)
  assert.match(msg.text, /新增 7 个/)
  assert.doesNotMatch(msg.text, /新增 vm-01 · vm-02/)
  assert.match(msg.text, /· vm-01 无效凭证/)
  assert.match(msg.text, /· vm-05 无效凭证/)
  assert.doesNotMatch(msg.text, /· vm-06 无效凭证/)
  assert.match(msg.text, /另有 2 个/)
})

test('channels ready requires both enable and destination', () => {
  const ready = notifyChannelsReady(
    normalizeNotifyConfig({
      email: { enabled: true, host: 'smtp.x', to: 'a@x.com' },
      telegram: { enabled: true, bot_token: '', chat_id: '1' },
    }),
  )
  assert.equal(ready.email, true)
  assert.equal(ready.telegram, false)
  assert.equal(ready.any, true)
})

test('telegram test send does not require the channel switch', async () => {
  const cfg = normalizeNotifyConfig({
    telegram: { enabled: false, bot_token: '999:secret-token', chat_id: '42' },
  })
  const out = await sendNotifyTest(cfg, 'telegram', {
    fetch: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }),
    snapshot: { at: new Date().toISOString(), available: 0, with_token: 0, total: 0, accounts: [] },
  })
  assert.equal(out.ok, true)
  assert.equal(out.channel, 'telegram')
})

test('telegram send uses bot API and never echoes the token', async () => {
  const cfg = normalizeNotifyConfig({
    telegram: { enabled: true, bot_token: '999:secret-token', chat_id: '42' },
  })
  let called = null
  const out = await sendTelegramNotify(
    cfg,
    { text: 'hello' },
    {
      fetch: async (url, init) => {
        called = { url, init }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true }),
        }
      },
    },
  )
  assert.equal(out.ok, true)
  assert.match(called.url, /api\.telegram\.org\/bot999:secret-token\/sendMessage/)
  assert.equal(JSON.parse(called.init.body).chat_id, '42')

  await assert.rejects(
    () =>
      sendTelegramNotify(
        cfg,
        { text: 'x' },
        {
          fetch: async () => ({
            ok: false,
            status: 401,
            text: async () => JSON.stringify({ ok: false, description: '401 999:secret-token unauthorized' }),
          }),
        },
      ),
    (err) => {
      assert.doesNotMatch(String(err.message), /secret-token/)
      return true
    },
  )
})

test('monitor fires recover once and respects cooldown', async () => {
  const snaps = [
    summarizePoolAvailability([{ id: 'vm-01', has_token: true, cred_status: { key: 'bad', text: '不可用' } }]),
    summarizePoolAvailability([{ id: 'vm-01', has_token: true, cred_status: { key: 'ok', text: '可用' } }]),
    summarizePoolAvailability([{ id: 'vm-01', has_token: true, cred_status: { key: 'ok', text: '可用' } }]),
  ]
  let i = 0
  const sent = []
  const monitor = createNotifyMonitor({
    config: {
      enabled: true,
      cooldown_sec: 300,
      events: { pool_empty: true, pool_recovered: true, digest: false, revoked: false, invalid: false },
    },
    snapshot: async () => snaps[Math.min(i++, snaps.length - 1)],
    send: async (msg, event) => {
      sent.push(event.type)
      return { ok: true }
    },
  })
  await monitor.runOnce()
  await monitor.runOnce()
  await monitor.runOnce()
  assert.deepEqual(sent, ['pool_empty', 'pool_recovered'])
})

test('test helper routes to the asked channel', async () => {
  const cfg = normalizeNotifyConfig({
    telegram: { enabled: true, bot_token: '1:t', chat_id: '2' },
  })
  const out = await sendNotifyTest(cfg, 'telegram', {
    fetch: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }),
    snapshot: summarizePoolAvailability([]),
  })
  assert.equal(out.channel, 'telegram')
})

test('wecom webhook is redacted, merged and accepts a bare key', async () => {
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd1234-ef56-7890'
  const prev = normalizeNotifyConfig({ wecom: { enabled: true, webhook: url } })
  const merged = mergeNotifyConfig(prev, { wecom: { enabled: true, webhook: '', mention_all: true } })
  assert.equal(merged.wecom.webhook, url)
  assert.equal(merged.wecom.mention_all, true)
  const pub = publicNotifyConfig(merged)
  assert.equal(pub.wecom.webhook, '')
  assert.equal(pub.wecom.webhook_set, true)
  assert.equal(notifyChannelsReady(merged).wecom, true)
  assert.equal(wecomWebhookUrl('abcd1234-ef56-7890'), url)
  assert.equal(wecomWebhookUrl('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), '')
  assert.equal(wecomWebhookUrl('not a url'), '')
  for (const other of [
    'https://example.com/cgi-bin/webhook/send?key=x',
    'https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send?key=x',
    'https://qyapi.weixin.qq.com:8443/cgi-bin/webhook/send?key=x',
    'https://u:p@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
    'https://qyapi.weixin.qq.com/cgi-bin/other?key=x',
  ]) {
    assert.equal(wecomWebhookUrl(other), '', other)
  }
  assert.equal(
    notifyChannelsReady(normalizeNotifyConfig({ wecom: { enabled: true, webhook: 'bad url' } })).wecom,
    false,
  )
})

test('wecom send posts a text message and never echoes the key', async () => {
  const cfg = normalizeNotifyConfig({ wecom: { enabled: true, webhook: 'secret-key-123456', mention_all: true } })
  let called = null
  const out = await sendWecomNotify(
    cfg,
    { text: '你'.repeat(1000) },
    {
      fetch: async (u, init) => {
        called = { url: u, init }
        return { ok: true, status: 200, text: async () => '{"errcode":0,"errmsg":"ok"}' }
      },
    },
  )
  assert.equal(out.ok, true)
  assert.equal(out.channel, 'wecom')
  assert.match(called.url, /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=secret-key-123456/)
  const body = JSON.parse(called.init.body)
  assert.equal(body.msgtype, 'text')
  assert.deepEqual(body.text.mentioned_list, ['@all'])
  assert.ok(Buffer.byteLength(body.text.content) <= 2048)
  assert.match(body.text.content, /…$/)

  await assert.rejects(
    () =>
      sendWecomNotify(
        cfg,
        { text: 'x' },
        {
          fetch: async () => ({
            ok: true,
            status: 200,
            text: async () => '{"errcode":93000,"errmsg":"invalid webhook url, key=secret-key-123456"}',
          }),
        },
      ),
    (err) => {
      assert.match(String(err.message), /wecom_93000/)
      assert.doesNotMatch(String(err.message), /secret-key-123456/)
      return true
    },
  )
})

test('dispatch includes wecom and the test helper routes to it', async () => {
  const cfg = normalizeNotifyConfig({ wecom: { enabled: true, webhook: 'secret-key-123456' } })
  const fetch = async () => ({ ok: true, status: 200, text: async () => '{"errcode":0}' })
  const all = await dispatchNotify(cfg, { text: 'hi' }, { fetch })
  assert.equal(all.ok, true)
  assert.deepEqual(
    all.results.map((r) => r.channel),
    ['wecom'],
  )
  const out = await sendNotifyTest(normalizeNotifyConfig({ wecom: { webhook: 'secret-key-123456' } }), 'wecom', {
    fetch,
    snapshot: summarizePoolAvailability([]),
  })
  assert.equal(out.channel, 'wecom')
})

/** Scripted SMTP peer: answers each client line in order and records what it was sent. */
function fakeSmtp({ starttls }) {
  const sent = []
  const socket = new (class extends EventEmitter {})()
  const reply = (text) => setImmediate(() => socket.emit('data', Buffer.from(text)))
  socket.write = (data) => {
    const line = String(data)
    sent.push(line)
    if (line.startsWith('EHLO')) reply(`250-smtp.test\r\n${starttls ? '250-STARTTLS\r\n' : ''}250 AUTH LOGIN\r\n`)
    else if (line.startsWith('STARTTLS')) reply('220 go ahead\r\n')
    else if (line.startsWith('AUTH') || sent.at(-2)?.startsWith('AUTH')) reply('334 next\r\n')
    else if (sent.at(-3)?.startsWith('AUTH')) reply('235 ok\r\n')
    else if (line.startsWith('DATA')) reply('354 send\r\n')
    else if (line.startsWith('QUIT')) reply('221 bye\r\n')
    else reply('250 ok\r\n')
  }
  socket.end = () => {}
  socket.destroy = () => {}
  reply('220 smtp.test ready\r\n')
  return { socket, sent }
}

const EMAIL_CFG = {
  email: { host: 'smtp.test', port: 587, secure: false, user: 'ops', pass: 'hunter2', to: ['a@x.test'] },
}

test('email refuses to log in when the server offers no STARTTLS', async () => {
  const peer = fakeSmtp({ starttls: false })
  await assert.rejects(
    sendEmailNotify(EMAIL_CFG, { title: 't', text: 'x' }, { connect: async () => peer.socket }),
    /smtp_starttls_unavailable/,
  )
  assert.equal(
    peer.sent.some((line) => line.includes(Buffer.from('hunter2').toString('base64'))),
    false,
  )
})

test('email upgrades to TLS before AUTH and dot-stuffs the body', async () => {
  const peer = fakeSmtp({ starttls: true })
  let upgraded = false
  const result = await sendEmailNotify(
    EMAIL_CFG,
    { title: 't', text: 'line one\n.\nQUIT\n.leading dot\r\nlast' },
    {
      connect: async () => peer.socket,
      upgradeTls: async (socket) => {
        upgraded = true
        return socket
      },
    },
  )
  assert.equal(result.ok, true)
  assert.equal(upgraded, true)
  const auth = peer.sent.findIndex((line) => line.startsWith('AUTH'))
  const tls = peer.sent.findIndex((line) => line.startsWith('STARTTLS'))
  assert.ok(tls >= 0 && tls < auth)
  const data = peer.sent.find((line) => line.includes('Subject:'))
  assert.match(data, /\r\nline one\r\n\.\.\r\nQUIT\r\n\.\.leading dot\r\nlast\r\n\.\r\n$/)
})

test('smtpDataText doubles leading dots and normalizes line ends', () => {
  assert.equal(smtpDataText('a\n.\r.b\r\nc'), 'a\r\n..\r\n..b\r\nc')
  assert.equal(smtpDataText(null), '')
})
