// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { aheadText, COULDNT_TELL, NOT_AVAILABLE, NOT_CHECKED, trendText, valueSecurity } from './valueSecurity.js'

const feed = (metrics, extra = {}) => ({ loading: false, error: null, data: { status: 'ok', metrics }, ...extra })
const byKey = (f) => Object.fromEntries(valueSecurity(f).map((x) => [x.key, x]))

const live = {
  blocked: { status: 'ok', value: 393407, previous: 350000 },
  zero_day: { status: 'ok', value: 19 },
  sus_to_mal: { status: 'ok', value: 24, ahead_minutes: 754 },
}

test('all three numbers, with the trend and the head start', () => {
  const v = byKey(feed(live))
  assert.equal(v.blocked.text, (393407).toLocaleString())
  assert.equal(v.blocked.note, 'Up 12% on the 30 days before')
  assert.equal(v.zero_day.text, '19')
  assert.equal(v.zero_day.note, null)
  assert.equal(v.sus_to_mal.text, '24')
  assert.equal(v.sus_to_mal.note, 'Spotted on average 13 hours before they were confirmed')
})

test('trend: up, down, flat, and none without a usable previous', () => {
  assert.equal(trendText(90, 100), 'down 10% on the 30 days before')
  assert.equal(trendText(100.2, 100), 'about the same as the 30 days before')
  assert.equal(trendText(100, null), null)
  assert.equal(trendText(100, 0), null)
  assert.equal(trendText(100, ''), null)
})

test('head start in the plainest unit', () => {
  assert.equal(aheadText(45), '45 minutes')
  assert.equal(aheadText(1), '1 minute')
  assert.equal(aheadText(754), '13 hours')
  assert.equal(aheadText(60 * 72), '3 days')
  assert.equal(aheadText(null), null)
  assert.equal(aheadText(0), null)
})

test('a failed read says not checked, never 0', () => {
  const v = byKey(feed({ ...live, zero_day: { status: 'error', value: null } }))
  assert.equal(v.zero_day.state, 'error')
  assert.equal(v.zero_day.text, NOT_CHECKED)
  assert.equal(v.blocked.state, 'ok')
})

test('a null reading or an ok with no number says couldn\'t tell', () => {
  const v = byKey(feed({ ...live, blocked: { status: 'empty', value: null }, sus_to_mal: { status: 'ok', value: null } }))
  assert.equal(v.blocked.text, COULDNT_TELL)
  assert.equal(v.sus_to_mal.text, COULDNT_TELL)
})

test('a cube the tenant lacks says not available, the others still show', () => {
  const v = byKey(feed({ ...live, zero_day: { status: 'unavailable', value: null } }))
  assert.equal(v.zero_day.text, NOT_AVAILABLE)
  assert.equal(v.blocked.state, 'ok')
})

test('the whole feed failing, missing, or loading', () => {
  for (const x of valueSecurity({ loading: false, error: new Error('x'), data: null })) assert.equal(x.text, NOT_CHECKED)
  for (const x of valueSecurity(feed({}))) assert.equal(x.text, NOT_CHECKED)
  for (const x of valueSecurity({ loading: true, data: null })) assert.equal(x.state, 'loading')
})

test('a failed previous window drops only the trend', () => {
  const v = byKey(feed({ ...live, blocked: { status: 'ok', value: 5, previous: null } }))
  assert.equal(v.blocked.text, '5')
  assert.equal(v.blocked.note, null)
})
