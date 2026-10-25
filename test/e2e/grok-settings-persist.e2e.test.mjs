// Settings › Grok: PUT through the panel API, restart the gateway, GET shows the saved values.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startGateway, api } from '../harness.mjs'

test('grok settings persist across a gateway restart', async () => {
  let gw = await startGateway()
  const project = gw.project
  try {
    const before = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(before.status, 200)
    const draft = { ...before.json.data }
    delete draft.sessions
    draft.grok = {
      ...(draft.grok || {}),
      enabled: true,
      base_url: 'https://api.x.ai',
      quota: { ...(draft.grok?.quota || {}), max_concurrency: 7, max_rpm: 120 },
      clients: { ...(draft.grok?.clients || {}), claude_code: 'allow' },
      billing: { background: false, min_interval_sec: 7200 },
    }
    const put = await api(gw, 'PUT', '/api/panel/routing', { body: draft })
    assert.equal(put.status, 200, put.text)
    const after = (await api(gw, 'GET', '/api/panel/routing')).json.data.grok
    assert.equal(after?.enabled, true)
    await gw.stop()

    gw = await startGateway({ project })
    const reloaded = (await api(gw, 'GET', '/api/panel/routing')).json.data.grok
    assert.equal(reloaded?.enabled, true)
    assert.equal(reloaded.base_url, 'https://api.x.ai')
    assert.equal(reloaded.quota.max_concurrency, 7)
    assert.equal(reloaded.quota.max_rpm, 120)
    assert.equal(reloaded.clients.claude_code, 'allow')
    assert.deepEqual(reloaded.billing, { background: false, min_interval_sec: 7200 })
  } finally {
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
})
