// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { dhcpTotal, NO_READINGS, NOT_CHECKED } from './dhcpRequests.js'

const feed = (metrics, extra = {}) => ({ loading: false, error: null, data: { status: 'ok', metrics }, ...extra })

test('a total reads as a whole count', () => {
  const f = feed({ discover: { today: { status: 'ok', value: 12483 } } })
  assert.deepEqual(dhcpTotal(f, 'discover', 'today'), { state: 'ok', value: 12483, text: '12,483' })
  const g = feed({ no_address: { last_30_days: { status: 'ok', value: 449710.75 } } })
  assert.equal(dhcpTotal(g, 'no_address', 'last_30_days').text, '449,711')
})

test('a failed read, a dead feed or a missing key is not checked, never 0', () => {
  assert.equal(dhcpTotal(feed({ discover: { today: { status: 'error', value: null } } }), 'discover', 'today').text, NOT_CHECKED)
  assert.equal(dhcpTotal({ loading: false, error: 'boom', data: null }, 'discover', 'today').text, NOT_CHECKED)
  assert.equal(dhcpTotal(feed({}), 'discover', 'today').text, NOT_CHECKED)
})

test('no samples is no readings, not 0', () => {
  const t = dhcpTotal(feed({ discover: { today: { status: 'empty', value: null } } }), 'discover', 'today')
  assert.equal(t.text, NO_READINGS)
  assert.equal(t.value, null)
})

test('a real zero is shown', () => {
  assert.equal(dhcpTotal(feed({ no_address: { today: { status: 'ok', value: 0 } } }), 'no_address', 'today').text, '0')
})

test('loading', () => {
  assert.equal(dhcpTotal({ loading: true, data: null }, 'discover', 'today').state, 'loading')
})
