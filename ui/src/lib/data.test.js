// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { KNOWN_SLICES, sliceAccessors, sliceState, sliceUrl } from './data.js'

// These tests exist for one reason: /api/data can now answer with FEWER keys
// than the full payload, and every panel in this app renders "no rows and
// status !== 'error'" as <Empty/> — "you have none". So an absent slice must
// never reach a panel as an empty state, and a slice the tab never asked for
// must never reach a panel at all.

const FULL_ISH = {
  auditLogs: [{ ts: '2026-01-01', action: 'CREATE' }],
  _meta: { auditLogs: 'ok' },
}

test('a requested slice missing from the payload reads as error, never empty', () => {
  // The tab asked for auditLogs; the payload does not contain it. The read did
  // not deliver, so the only honest word is "error" — "empty" would claim the
  // tenant has no audit activity, which nobody checked.
  const { rows, status } = sliceState({ zones: [], _meta: { zones: 'ok' } }, 'auditLogs')
  assert.deepEqual(rows, [])
  assert.equal(status, 'error', 'an absent-but-requested slice must not render as "you have none"')
  assert.notEqual(status, 'empty')
})

test('a null payload (loading or failed fetch) also reads as error, never empty', () => {
  assert.equal(sliceState(null, 'auditLogs').status, 'error')
  assert.equal(sliceState(undefined, 'zones').status, 'error')
})

test('a rows key with no _meta status still reads as error', () => {
  // Half a slice is not a slice: rows with no status cannot be told apart from
  // a quiet feed, so it fails loud.
  assert.equal(sliceState({ auditLogs: [], _meta: {} }, 'auditLogs').status, 'error')
})

test('a genuinely empty slice keeps its own "empty" word', () => {
  // The fix must not turn every quiet feed into a fake outage — that is the
  // same lie pointed the other way.
  const { rows, status } = sliceState({ auditLogs: [], _meta: { auditLogs: 'empty' } }, 'auditLogs')
  assert.deepEqual(rows, [])
  assert.equal(status, 'empty')
})

test('a healthy slice passes its rows and status through untouched', () => {
  const { rows, status } = sliceState(FULL_ISH, 'auditLogs')
  assert.equal(rows.length, 1)
  assert.equal(status, 'ok')
})

test('the accessors throw for a slice the tab never declared', () => {
  // An undeclared slice has no honest state: it was not requested, so it is
  // neither ok, nor empty, nor error. Throwing is what stops it reaching a
  // panel and being rendered as one of those three.
  const a = sliceAccessors(['auditLogs'], FULL_ISH)
  assert.throws(() => a.rows('zones'), /was not requested by this tab/)
  assert.throws(() => a.status('zones'), /was not requested by this tab/)
})

test('the accessors answer normally for a declared slice', () => {
  const a = sliceAccessors(['auditLogs'], FULL_ISH)
  assert.equal(a.rows('auditLogs').length, 1)
  assert.equal(a.status('auditLogs'), 'ok')
})

test('the request URL is sorted, so one slice list is one cache key', () => {
  assert.equal(sliceUrl(['zones']), '/api/data?only=zones')
  assert.equal(sliceUrl(['zones', 'auditLogs']), '/api/data?only=auditLogs,zones')
  assert.equal(sliceUrl(['auditLogs', 'zones']), sliceUrl(['zones', 'auditLogs']))
})

test('asking for a slice name the server does not have throws before the request', () => {
  // The server answers an unknown name with a 400, never a thinner 200. This
  // turns that into a developer error at the call site.
  assert.throws(() => sliceUrl(['zonez']), /no slice named "zonez"/)
})

test('the client slice vocabulary matches the server (go dashboard.go dataSlices)', () => {
  assert.deepEqual(
    [...KNOWN_SLICES].sort(),
    ['auditLogs', 'dnsViews', 'feeds', 'hosts', 'leases', 'secPolicies', 'subnets', 'zones'],
  )
})
