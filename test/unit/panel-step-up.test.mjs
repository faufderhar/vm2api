import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizePanelStepUp } from '../../src/lib/admin/panel-routes.mjs'
import { createRespond } from '../../src/lib/http/respond.mjs'

// The production helper on purpose: it returns nothing, which once let refused requests continue.
const { json } = createRespond({ rewrite: { enabled: false }, limits: {} }, {})

function exchange() {
  const res = {
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = JSON.parse(body)
    },
  }
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' }, panelUser: 'admin' }
  return { req, res }
}

test('a missing password stops the caller and answers step_up_required', async () => {
  const { req, res } = exchange()
  const denied = await authorizePanelStepUp(req, res, {}, json)
  assert.equal(denied, true)
  assert.equal(res.status, 401)
  assert.equal(res.body.error.code, 'step_up_required')
})

test('a wrong password stops the caller and answers step_up_failed', async () => {
  const { req, res } = exchange()
  const denied = await authorizePanelStepUp(req, res, { password: 'nope' }, json)
  assert.equal(denied, true)
  assert.equal(res.status, 401)
  assert.equal(res.body.error.code, 'step_up_failed')
})
