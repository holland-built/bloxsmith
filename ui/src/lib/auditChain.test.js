// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// The shapes here are copied from a real `/api/audit/log` response on the live
// tenant (2026-08-20, 837 entries), not invented. That matters for two of them:
// `ts` is float epoch SECONDS, and `seq`/`key_id`/`mac` are present on 718 of
// the 837 and absent on the rest, so "an entry with no seq" is a normal state
// and not a corrupt one.

import assert from 'node:assert/strict'
import test from 'node:test'
import { chainRows, detailText, entryTimeMs, eventTally, readShortfall } from './auditChain.js'

const REAL_ENTRY = {
  actor: 'loopback',
  event: 'write-refused-read-only',
  ts: 1784580619.265203,
  detail: {
    image_digest: 'app-vdev-cda9016',
    instance_id: '52066f34',
    method: 'GET',
    path: '/api/teardown/seed-demo/stream',
    reason: 'tenant-read-only',
    tenant: 'b84022133fb7/-',
  },
  hash: '123ba6f',
  prev_hash: '0000000',
  seq: 41,
}

// --- the 1970 bug -----------------------------------------------------------

test('float epoch seconds become milliseconds, not a date in 1970', () => {
  const ms = entryTimeMs(1784580619.265203)
  assert.equal(ms, 1784580619265.203)
  assert.equal(new Date(ms).getUTCFullYear(), 2026)
  // The whole point: the naive reading is off by a factor of 1000 and produces
  // a date that renders without complaint.
  assert.equal(new Date(1784580619.265203).getUTCFullYear(), 1970)
})

test('an ISO string still works, so a portal row handed here does not become 1970 either', () => {
  const ms = entryTimeMs('2026-08-20T14:54:18.899007Z')
  assert.equal(new Date(ms).getUTCFullYear(), 2026)
})

test('a numeric STRING is epoch seconds, not whatever Date.parse makes of it', () => {
  assert.equal(entryTimeMs('1784580619.265203'), 1784580619265.203)
})

test('an unusable timestamp is null, never a guess', () => {
  for (const bad of [undefined, null, '', '   ', 'not a date', {}, [], NaN, Infinity]) {
    assert.equal(entryTimeMs(bad), null, `${JSON.stringify(bad)} must be null`)
  }
})

// --- detail ----------------------------------------------------------------

test('detail drops the two keys every entry carries and sorts the rest', () => {
  assert.equal(
    detailText(REAL_ENTRY.detail),
    'method=GET · path=/api/teardown/seed-demo/stream · reason=tenant-read-only · tenant=b84022133fb7/-',
  )
})

test('detail survives a nested value, a null and a non-object', () => {
  assert.equal(detailText({ a: { b: 1 }, c: null }), 'a={"b":1} · c=')
  for (const bad of [undefined, null, 'string', 42, ['a']]) assert.equal(detailText(bad), '')
})

test('an entry whose detail is only the two noise keys renders an empty cell, not "{}"', () => {
  assert.equal(detailText({ image_digest: 'app-v3.68.2', instance_id: 'abc' }), '')
})

// --- rows -------------------------------------------------------------------

test('a chain entry becomes a row whose time and sort key are the same number', () => {
  const [row] = chainRows([REAL_ENTRY])
  assert.equal(row.actor, 'loopback')
  assert.equal(row.event, 'write-refused-read-only')
  assert.equal(row._ms, 1784580619265.203)
  assert.equal(row._key, 'seq-41')
  assert.ok(row._search.includes('tenant-read-only'))
  assert.ok(row._search.includes('write-refused-read-only'))
  assert.equal(row._search, row._search.toLowerCase(), 'the haystack must be pre-lowercased')
})

test('an entry with no seq still gets a unique key — 119 of 837 real entries have none', () => {
  const { seq, ...noSeq } = REAL_ENTRY
  void seq
  const rows = chainRows([noSeq, noSeq])
  assert.equal(rows[0]._key, 'idx-0')
  assert.equal(rows[1]._key, 'idx-1')
  assert.notEqual(rows[0]._key, rows[1]._key)
})

test('order is preserved exactly — the panel owns sort, this does not', () => {
  const rows = chainRows([{ event: 'a' }, { event: 'b' }, { event: 'c' }])
  assert.deepEqual(rows.map((r) => r.event), ['a', 'b', 'c'])
})

test('a missing or non-array entries field is an empty list, never a throw', () => {
  for (const bad of [undefined, null, {}, 'entries', 7]) assert.deepEqual(chainRows(bad), [])
})

test('a garbage entry renders blank fields rather than "undefined" on screen', () => {
  const [row] = chainRows([{}])
  assert.equal(row.actor, '')
  assert.equal(row.event, '')
  assert.equal(row.detail, '')
  assert.equal(row._ms, null)
})

// --- tally ------------------------------------------------------------------

test('the tally counts event kinds, most frequent first', () => {
  // The real distribution, scaled down.
  const entries = [
    ...Array(6).fill({ event: 'write-authorized' }),
    ...Array(4).fill({ event: 'write-refused-read-only' }),
    ...Array(2).fill({ event: 'update-apply' }),
    { event: 'provision-subnet' },
  ]
  assert.deepEqual(eventTally(entries), [
    { event: 'write-authorized', count: 6 },
    { event: 'write-refused-read-only', count: 4 },
    { event: 'update-apply', count: 2 },
    { event: 'provision-subnet', count: 1 },
  ])
})

test('a tie breaks by name, so the chart does not reshuffle between polls', () => {
  const a = eventTally([{ event: 'zeta' }, { event: 'alpha' }])
  const b = eventTally([{ event: 'alpha' }, { event: 'zeta' }])
  assert.deepEqual(a, b)
  assert.equal(a[0].event, 'alpha')
})

test('an event with no name is counted as "unnamed" rather than dropped', () => {
  assert.deepEqual(eventTally([{ event: '' }, {}]), [{ event: 'unnamed', count: 2 }])
})

test('a kind this code has never seen counts on the day it is added', () => {
  // The guard against the outcome-binary this replaced: nothing here enumerates
  // event names, so a new one needs no edit.
  assert.deepEqual(eventTally([{ event: 'some-event-invented-tomorrow' }]), [
    { event: 'some-event-invented-tomorrow', count: 1 },
  ])
})

// --- the list saying it is short --------------------------------------------

test('a clean response disclaims nothing', () => {
  assert.equal(readShortfall({ entries: [], chain_valid: true }), null)
  assert.equal(readShortfall(undefined), null)
  // Present-but-zero must read the same as absent: the server omits these, and a
  // consumer that renders on the key existing would show a banner for a healthy log.
  assert.equal(readShortfall({ skipped_lines: 0, read_error: '' }), null)
})

test('an unreadable log says so', () => {
  assert.match(readShortfall({ read_error: 'is a directory' }), /could not be read \(is a directory\)/)
})

test('dropped lines say how many, and singular reads correctly', () => {
  assert.match(readShortfall({ skipped_lines: 2 }), /2 lines on disk could not be decoded/)
  assert.match(readShortfall({ skipped_lines: 1 }), /1 line on disk could not be decoded/)
})

test('both failures at once are both said — they are different failures', () => {
  const s = readShortfall({ read_error: 'boom', skipped_lines: 3 })
  assert.match(s, /could not be read/)
  assert.match(s, /3 lines/)
})
