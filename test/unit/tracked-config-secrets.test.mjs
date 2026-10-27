import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// S3: tracked config files are policy defaults only. A real credential pasted
// into one would be committed; this guard fails before that reaches a push.
const ROOT = path.resolve(import.meta.dirname, '../..')
const TRACKED = ['src/config/routing.json', 'src/config/gateway-v2.example.json']
const SECRET_KEY =
  /(?:^|_)(?:token|secret|password|passwd|api_?key|cookie|authorization|session_?key|webhook|bot_token)$/i
const CREDENTIAL_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bxai-[A-Za-z0-9_-]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /\brt_[A-Za-z0-9._-]{20,}/,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/, // Telegram bot token
  /[?&]key=[A-Za-z0-9-]{16,}/, // WeCom / webhook key
]
// Placeholders the example file may carry.
const PLACEHOLDER = /^(?:|<.*>|\$\{.*\}|change-?me|example.*|xxx+|\*+|.*REDACTED.*)$/i

function walk(node, at, out) {
  if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${at}[${i}]`, out))
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') out.push({ path: `${at}.${key}`, key, value })
      else walk(value, `${at}.${key}`, out)
    }
  }
  return out
}

for (const rel of TRACKED) {
  test(`tracked ${rel} carries no live credential`, (t) => {
    const file = path.join(ROOT, rel)
    if (!fs.existsSync(file)) return t.skip(`${rel} not present`)
    const strings = walk(JSON.parse(fs.readFileSync(file, 'utf8')), '', [])
    for (const { path: at, key, value } of strings) {
      if (SECRET_KEY.test(key)) assert.match(value.trim(), PLACEHOLDER, `${rel}${at} must stay empty/placeholder`)
      for (const pattern of CREDENTIAL_VALUE) assert.doesNotMatch(value, pattern, `${rel}${at} looks like a credential`)
    }
  })
}

test('the guard itself flags a pasted credential', () => {
  const strings = walk({ notify: { telegram: { bot_token: 'x' }, wecom: { webhook: '' } } }, '', [])
  const flagged = strings.filter(({ key, value }) => SECRET_KEY.test(key) && !PLACEHOLDER.test(value.trim()))
  assert.deepEqual(
    flagged.map((item) => item.path),
    ['.notify.telegram.bot_token'],
  )
})
