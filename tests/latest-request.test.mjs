import assert from 'node:assert/strict'
import test from 'node:test'

import { makeLatestRequestGate } from '../latest-request.js'

test('an older refresh cannot apply after a newer refresh starts', () => {
  const gate = makeLatestRequestGate()
  const initialOffline = gate.begin()
  const reconnect = gate.begin()
  assert.equal(gate.isCurrent(reconnect), true)
  assert.equal(gate.isCurrent(initialOffline), false)
})
