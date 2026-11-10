// Run with: npm test  (node --test, no test framework dependency)
//
// Security's headline numbers. Each must come from a feed the page already
// loads, agree with the panel it jumps to, and never turn a missing feed into
// a reassuring 0.

import assert from 'node:assert/strict'
import test from 'node:test'
import { securityHeadline } from './securityHeadline.js'

const ok = (data) => ({ loading: false, error: null, data })
const HUB = ok({ availability: 'ok', blocked: 12, logged: 8, counts: { critical: 1, high: 2, medium: 3, low: 4 }, events: [{}, {}] })
const LOOK = ok({ domains: [{ suspicious: true }, { suspicious: false }, { suspicious: true }] })
const EXP = ok({ availability: 'ok', data: { rows: [{}], count: 1, total_available: 40 } })
const AXUR = ok({ configured: true, total_credentials: 9, vendors: [{}, {}] })
const byKey = (feeds) => Object.fromEntries(securityHeadline(feeds).map((t) => [t.key, t]))

test('the five numbers come from the feeds, in order', () => {
  const t = securityHeadline({ hub: HUB, lookalikes: LOOK, exposures: EXP, axur: AXUR })
  assert.deepEqual(t.map((x) => [x.key, x.value]), [
    ['attacks', 3], ['blocked', 12], ['lookalikes', 2], ['exposures', 40], ['credentials', 9],
  ])
})

test('only problems are coloured: critical or high events red, suspicious lookalikes amber', () => {
  const t = byKey({ hub: HUB, lookalikes: LOOK, exposures: EXP, axur: AXUR })
  assert.equal(t.attacks.tone, 'crit')
  assert.equal(t.lookalikes.tone, 'warn')
  assert.equal(t.blocked.tone, null)
  assert.equal(t.credentials.tone, null)
  const calm = byKey({ hub: ok({ availability: 'ok', counts: { critical: 0, high: 0 } }), lookalikes: ok({ domains: [] }), exposures: EXP, axur: AXUR })
  assert.equal(calm.attacks.value, 0)
  assert.equal(calm.attacks.tone, null)
  assert.equal(calm.lookalikes.tone, null)
})

test('a dead or loading feed is not a zero', () => {
  const dead = { loading: false, error: new Error('x'), data: null }
  const t = byKey({ hub: ok({ availability: 'error' }), lookalikes: dead, exposures: ok({ availability: 'error' }), axur: { loading: true, data: null } })
  assert.equal(t.attacks.value, null)
  assert.equal(t.attacks.state, 'failed')
  assert.equal(t.blocked.value, null)
  assert.equal(t.lookalikes.value, null)
  assert.equal(t.exposures.value, null)
  assert.equal(t.credentials.state, 'loading')
})

test('Axur without a key says not set up, not 0', () => {
  const t = byKey({ hub: HUB, lookalikes: LOOK, exposures: EXP, axur: ok({ configured: false }) })
  assert.equal(t.credentials.value, null)
  assert.equal(t.credentials.state, 'notSetUp')
})

test('a capped event page says how many events the count covers', () => {
  const t = byKey({ hub: ok({ availability: 'ok', truncated: true, returned: 50, counts: { critical: 0, high: 0 }, events: [] }), lookalikes: LOOK, exposures: EXP, axur: AXUR })
  assert.equal(t.attacks.right, 'latest 50')
  assert.match(t.attacks.tip, /Counted from the 50 events shown/)
})

test('exposures without a reported total show the rows loaded and say so', () => {
  const t = byKey({ hub: HUB, lookalikes: LOOK, exposures: ok({ availability: 'metadata-degraded', data: { rows: [{}, {}], count: 2 } }), axur: AXUR })
  assert.equal(t.exposures.value, 2)
  assert.equal(t.exposures.right, 'loaded')
})
