import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeJwtPayload,
  firstStringOrEpoch,
  openaiClaimsFromIdToken,
  openaiIdentityFromJwt,
  openaiIdentityFromOauthTokens,
} from '../../src/lib/oauth/openai-jwt.mjs'

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.sig`
}

test('decodeJwtPayload returns null for garbage', () => {
  assert.equal(decodeJwtPayload(''), null)
  assert.equal(decodeJwtPayload('not-a-jwt'), null)
  assert.equal(decodeJwtPayload('a.b'), null)
})

test('openaiIdentityFromJwt reads email and chatgpt_account_id', () => {
  const token = jwt({
    email: 'user@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-jwt-1' },
  })
  assert.deepEqual(openaiIdentityFromJwt(token), {
    email: 'user@example.com',
    chatgpt_account_id: 'acc-jwt-1',
    chatgpt_subscription_active_until: null,
  })
})

test('openaiIdentityFromOauthTokens prefers id_token email and merges account id', () => {
  const idToken = jwt({ email: 'from-id@example.com' })
  const accessToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-from-at' },
  })
  assert.deepEqual(openaiIdentityFromOauthTokens({ id_token: idToken, access_token: accessToken }), {
    email: 'from-id@example.com',
    chatgpt_account_id: 'acc-from-at',
    chatgpt_subscription_active_until: null,
  })
})

test('openaiIdentityFromOauthTokens tolerates missing tokens', () => {
  assert.deepEqual(openaiIdentityFromOauthTokens({}), {
    email: null,
    chatgpt_account_id: null,
    chatgpt_subscription_active_until: null,
  })
})

test('openaiIdentityFromJwt reads chatgpt_subscription_active_until from id_token payload', () => {
  const until = '2026-12-31T23:59:59Z'
  const idToken = jwt({ chatgpt_subscription_active_until: until })
  const accessToken = jwt({
    chatgpt_subscription_active_until: '2099-01-01T00:00:00Z',
  })
  assert.equal(openaiIdentityFromJwt(idToken).chatgpt_subscription_active_until, until)
  assert.deepEqual(openaiIdentityFromOauthTokens({ id_token: idToken, access_token: accessToken }), {
    email: null,
    chatgpt_account_id: null,
    chatgpt_subscription_active_until: until,
  })
})

test('openaiIdentityFromJwt reads chatgpt_subscription_active_until from auth claim', () => {
  const until = '2027-06-01T12:00:00Z'
  const token = jwt({
    'https://api.openai.com/auth': { chatgpt_subscription_active_until: until },
  })
  assert.equal(openaiIdentityFromJwt(token).chatgpt_subscription_active_until, until)
})

test('firstStringOrEpoch normalizes second and millisecond epochs', () => {
  assert.equal(firstStringOrEpoch(1_700_000_000), '2023-11-14T22:13:20.000Z')
  assert.equal(firstStringOrEpoch('1700000000000'), '2023-11-14T22:13:20.000Z')
  assert.equal(firstStringOrEpoch('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05Z')
})

test('openaiClaimsFromIdToken detects absent vs present subscription claim', () => {
  const bare = jwt({ email: 'a@b.com' })
  assert.deepEqual(openaiClaimsFromIdToken(bare), {
    has_chatgpt_subscription_active_until: false,
    chatgpt_subscription_active_until: null,
    has_chatgpt_plan_type: false,
    chatgpt_plan_type: null,
  })
  const withUntil = jwt({ chatgpt_subscription_active_until: 1_800_000_000 })
  const claims = openaiClaimsFromIdToken(withUntil)
  assert.equal(claims.has_chatgpt_subscription_active_until, true)
  assert.equal(claims.chatgpt_subscription_active_until, '2027-01-15T08:00:00.000Z')
})

test('openaiClaimsFromIdToken reads chatgpt_plan_type from auth claim', () => {
  const token = jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })
  assert.deepEqual(openaiClaimsFromIdToken(token), {
    has_chatgpt_subscription_active_until: false,
    chatgpt_subscription_active_until: null,
    has_chatgpt_plan_type: true,
    chatgpt_plan_type: 'plus',
  })
})
