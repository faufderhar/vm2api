import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

test('harness /health 200 without slot details', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'GET', '/health')
    assert.equal(r.status, 200)
    assert.equal(r.json.status, 'ok')
    assert.equal(r.json.service, 'vm2api')
    assert.equal(r.json.active_vm, undefined)
    assert.equal(r.json.capabilities, undefined)
  } finally {
    await gw.stop()
  }
})

test('GET /v1/models is harvested from mock catalog strings', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'GET', '/v1/models')
    assert.equal(r.status, 200)
    const ids = (r.json.data || r.json.models || []).map((m) => m.id || m)
    assert.ok(ids.includes('claude-haiku-4-5-20251001'), JSON.stringify(ids))
  } finally {
    await gw.stop()
  }
})

test('missing API key → 401', async () => {
  const gw = await startGateway()
  try {
    const res = await fetch(gw.baseUrl + '/v1/models')
    assert.equal(res.status, 401)
  } finally {
    await gw.stop()
  }
})
