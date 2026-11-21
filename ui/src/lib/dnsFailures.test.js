// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { CANT_TELL, failuresUrl, failuresView, NO_RECORDS, NOT_CHECKED, readWindow, saveWindow, WINDOW_KEY } from './dnsFailures.js'

const ok = (extra = {}) => ({
  status: 'ok', window: 'today', source: 'failure_records', total: 539374,
  codes: { nxdomain: 532584, servfail: 315, refused: 6460, other: 15 }, codes_status: 'ok',
  names: [{ name: 'a.example.', count: 390793 }], names_status: 'ok', ...extra,
})
const feed = (data, extra = {}) => ({ loading: false, error: null, data, ...extra })

test('a good read shows counts and says where they came from', () => {
  const v = failuresView(feed(ok()), 'today')
  assert.equal(v.state, 'ok')
  assert.equal(v.total.text, '539,374')
  assert.equal(v.codes.find((c) => c.key === 'servfail').text, '315')
  assert.deepEqual(v.names, [{ name: 'a.example.', count: 390793, text: '390,793' }])
  assert.equal(v.source, 'From the last 3 days of failure records')
  assert.equal(failuresView(feed(ok({ source: 'query_logs' })), 'today').source, 'From the query logs')
})

test('a failed read is not checked, never 0', () => {
  const failed = ok({ status: 'error', total: null, codes: { nxdomain: null, servfail: null, refused: null, other: null }, codes_status: 'error', names: null, names_status: 'error' })
  const v = failuresView(feed(failed), 'today')
  assert.equal(v.state, 'error')
  assert.equal(v.total.text, NOT_CHECKED)
  assert.ok(v.codes.every((c) => c.text === NOT_CHECKED && c.value === null))
  assert.equal(v.names, null)
  assert.equal(v.namesText, NOT_CHECKED)
  // A dead request, too.
  assert.equal(failuresView({ loading: false, error: 'boom', data: null }, 'today').total.text, NOT_CHECKED)
})

test('only the names failing keeps the totals', () => {
  const v = failuresView(feed(ok({ status: 'partial', names: null, names_status: 'error' })), 'today')
  assert.equal(v.state, 'ok')
  assert.equal(v.total.text, '539,374')
  assert.equal(v.namesText, NOT_CHECKED)
})

test('a group the server could not count says so; a real zero stays 0', () => {
  const v = failuresView(feed(ok({ total: null, codes: { nxdomain: 10, servfail: null, refused: 0, other: 0 } })), 'today')
  assert.equal(v.total.text, CANT_TELL)
  assert.equal(v.codes.find((c) => c.key === 'servfail').text, CANT_TELL)
  assert.equal(v.codes.find((c) => c.key === 'refused').text, '0')
})

test('no rows says we could not tell why, and never shows 0', () => {
  const empty = ok({ status: 'empty', total: null, codes: { nxdomain: null, servfail: null, refused: null, other: null }, names: [] })
  const v = failuresView(feed(empty), 'today')
  assert.equal(v.state, 'ok')
  assert.equal(v.total.text, CANT_TELL)
  assert.ok(v.codes.every((c) => c.text === CANT_TELL && c.value === null))
  assert.equal(v.names, null)
  assert.equal(v.namesText, CANT_TELL)
  assert.equal(v.note, NO_RECORDS)
  assert.equal(failuresView(feed(ok()), 'today').note, null)
})

test("another window's answer is never shown as this one's", () => {
  const v = failuresView(feed(ok({ window: 'yesterday' })), 'today')
  assert.equal(v.total.text, NOT_CHECKED)
})

test('loading', () => {
  assert.equal(failuresView({ loading: true, data: null }, 'today').state, 'loading')
})

test('the window is remembered, and a bad or missing one falls back to Today', () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(readWindow(storage), 'today')
  saveWindow('last 30 days', storage)
  assert.equal(store.get(WINDOW_KEY), 'last 30 days')
  assert.equal(readWindow(storage), 'last 30 days')
  store.set(WINDOW_KEY, 'forever')
  assert.equal(readWindow(storage), 'today')
  const broken = { getItem: () => { throw new Error('off') }, setItem: () => { throw new Error('off') } }
  assert.equal(readWindow(broken), 'today')
  saveWindow('today', broken)
})

test('the url carries the window', () => {
  assert.equal(failuresUrl('this week'), '/api/csp/dns-failures?window=this%20week')
})
