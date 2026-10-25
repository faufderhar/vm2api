// Regression: Settings › Grok saved fine but the panel always re-rendered defaults,
// because GET /api/panel/routing (buildRouting) never returned the `grok` block.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { buildRouting } from '../../src/lib/admin/panel-api.mjs'
import { normalizeGrokRouting } from '../../src/lib/protocol/grok-route.mjs'

const stickyRouter = { stats: () => ({}), reloadConfig() {} }
const accountQuota = {
  setMaxConcurrency() {},
  setMaxRpm() {},
  reloadConfig() {},
  applyTierConcurrency() {},
  applyTierRpm() {},
  repo: { get: () => null },
}

const EDIT = {
  enabled: true,
  base_url: 'https://api.x.ai',
  oauth: {
    refresh_skew_sec: 900,
    token_url: 'https://auth.x.ai/oauth2/token',
    client_id: 'my-client',
    scope: 'openid',
  },
  protocols: {
    'anthropic.messages': { mode: 'convert', enabled: true },
    'openai.chat': { mode: 'reject', enabled: false },
  },
  clients: { claude_code: 'allow', unknown: 'reject' },
  quota: { max_concurrency: 7, max_rpm: 120, max_sessions: 5 },
  billing: { background: false, min_interval_sec: 7200 },
}

function assertEdited(grok) {
  assert.ok(grok, 'GET /api/panel/routing must include grok')
  assert.equal(grok.enabled, true)
  assert.equal(grok.base_url, 'https://api.x.ai')
  assert.equal(grok.oauth.refresh_skew_sec, 900)
  assert.equal(grok.oauth.token_url, 'https://auth.x.ai/oauth2/token')
  assert.equal(grok.oauth.client_id, 'my-client')
  assert.equal(grok.oauth.scope, 'openid')
  assert.equal(grok.protocols['anthropic.messages'].mode, 'convert')
  assert.equal(grok.protocols['openai.chat'].mode, 'reject')
  assert.equal(grok.protocols['openai.responses'].mode, 'native')
  assert.equal(grok.clients.claude_code, 'allow')
  assert.equal(grok.clients.unknown, 'reject')
  assert.deepEqual([grok.quota.max_concurrency, grok.quota.max_rpm, grok.quota.max_sessions], [7, 120, 5])
  assert.deepEqual(grok.billing, { background: false, min_interval_sec: 7200 })
}

test('buildRouting returns the normalized grok block', () => {
  const data = buildRouting({ routingConfig: {}, stickyRouter }).data
  assert.deepEqual(data.grok, normalizeGrokRouting({}))
  const saved = buildRouting({ routingConfig: { grok: { enabled: true } }, stickyRouter }).data
  assert.equal(saved.grok.enabled, true)
})

test('Grok settings round-trip: PUT → GET → restart → GET keeps the edited values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-settings-roundtrip-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ concurrency: {}, tiers: {} }))
  const boot = () => {
    const ctx = { routingConfig: {} }
    const runtime = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
      get routingConfig() {
        return ctx.routingConfig
      },
      set routingConfig(v) {
        ctx.routingConfig = v
      },
      stickyRouter,
      accountQuota,
      requestLog: { setConfig() {} },
    })
    ctx.routingConfig = runtime.loadRoutingConfig()
    const runtimeCtx = runtime
    const responses = []
    let nextBody = null
    const handle = createPanelHandler({
      cfg: { paths: { project: root }, limits: { max_body_bytes: 1 << 20 } },
      get routingConfig() {
        return ctx.routingConfig
      },
      stickyRouter,
      persistRoutingPatch: (body) => runtimeCtx.persistRoutingPatch(body),
      restoreRoutingRuntime() {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        responses.push({ status, body: payload })
        return true
      },
      readBody: async () => nextBody,
    })
    const call = async (method, body) => {
      nextBody = body
      await handle({ method }, {}, new URL('http://localhost/api/panel/routing'))
      return responses.at(-1)
    }
    return { call }
  }
  try {
    const first = boot()
    // The panel PUTs the whole draft it got from GET, with the Grok edits applied.
    const loaded = (await first.call('GET')).body.data
    const draft = { ...loaded, grok: { ...(loaded.grok || {}), ...EDIT } }
    delete draft.sessions
    const put = await first.call('PUT', draft)
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assertEdited((await first.call('GET')).body.data.grok)
    assertEdited(JSON.parse(fs.readFileSync(routingFile, 'utf8')).grok)

    // Restart: a fresh runtime reads routing.json again.
    const second = boot()
    const reloaded = (await second.call('GET')).body.data
    assertEdited(reloaded.grok)

    // Saving another tab sends the (now hydrated) grok block back unchanged.
    const again = await second.call('PUT', { ...reloaded, sessions: undefined })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assertEdited((await second.call('GET')).body.data.grok)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
