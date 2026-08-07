// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capNotice,
  dataSpan,
  feedState,
  feedSummary,
  formatClock,
  formatDate,
  formatDuration,
  groupByResource,
  isDeletion,
  isFailure,
  isOutOfHours,
  newActors,
  notability,
  sinceIso,
  withinWindow,
} from './changes.js'

// The one field name every rule here reads is `ts`. Measured from the running
// server on 2026-08-06 — GET /api/csp-audit?limit=5 answers
// {count, rows, status, truncated} where each row carries exactly
// action, id, resource, result, ts, user, who_kind, who_role.
// `created_at` is the UPSTREAM ordering param (csp.go `_order_by`), never a
// field on these rows, so nothing below may read it.

// 2026-08-06T12:00:00Z as milliseconds, hand-computed and pinned so no test
// below re-derives a window boundary with the same arithmetic as the code.
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0)

test('the since parameter is exactly 24 hours before now, as an ISO instant', () => {
  // Hand-written literal: 24 h before 2026-08-06T12:00:00Z is the same clock
  // time the previous day.
  assert.equal(sinceIso(NOW), '2026-08-05T12:00:00.000Z')
})

test('rows older than the window are dropped, rows inside it are kept', () => {
  const rows = [
    { id: 'inside-newest', ts: '2026-08-06T11:59:00.000Z' },
    { id: 'inside-oldest', ts: '2026-08-05T12:00:01.000Z' },
    { id: 'one-second-too-old', ts: '2026-08-05T11:59:59.000Z' },
    { id: 'a-week-old', ts: '2026-07-30T12:00:00.000Z' },
  ]
  assert.deepEqual(
    withinWindow(rows, NOW).map((r) => r.id),
    ['inside-newest', 'inside-oldest'],
  )
})

test('a row stamped in the future is not "within the last 24 hours"', () => {
  // P4 says every rendered row's ts is inside the last 24 h. A row ahead of the
  // browser clock fails that on its upper edge just as an old row fails it on
  // its lower edge, so it is dropped rather than quietly shown.
  const rows = [{ id: 'future', ts: '2026-08-06T12:00:01.000Z' }]
  assert.deepEqual(withinWindow(rows, NOW), [])
})

test('a row with a missing or unparseable ts is dropped, never assumed recent', () => {
  const rows = [
    { id: 'no-ts' },
    { id: 'empty-ts', ts: '' },
    { id: 'junk-ts', ts: 'yesterday-ish' },
    { id: 'real', ts: '2026-08-06T09:00:00.000Z' },
  ]
  assert.deepEqual(
    withinWindow(rows, NOW).map((r) => r.id),
    ['real'],
  )
})

test('a non-array payload shapes to an empty window instead of throwing', () => {
  assert.deepEqual(withinWindow(undefined, NOW), [])
  assert.deepEqual(withinWindow(null, NOW), [])
})

// ---------- grouping by resource ----------

const GROUPED = [
  { id: 'a1', ts: '2026-08-06T11:00:00.000Z', resource: 'addressservice', action: 'UPDATE', result: 'success' },
  { id: 's1', ts: '2026-08-06T10:00:00.000Z', resource: 'subnetservice', action: 'CREATE', result: 'success' },
  { id: 'a2', ts: '2026-08-06T09:00:00.000Z', resource: 'addressservice', action: 'DELETE', result: 'success' },
  { id: 'd1', ts: '2026-08-06T08:00:00.000Z', resource: 'auth_zone', action: 'UPDATE', result: 'failed: conflict' },
  { id: 'a3', ts: '2026-08-06T07:00:00.000Z', resource: 'addressservice', action: 'UPDATE', result: 'failed: denied' },
]

test('rows collapse into one group per resource, newest row first inside each', () => {
  const groups = groupByResource(GROUPED)
  assert.deepEqual(
    groups.map((g) => g.resource),
    ['addressservice', 'subnetservice', 'auth_zone'],
  )
  assert.deepEqual(
    groups[0].rows.map((r) => r.id),
    ['a1', 'a2', 'a3'],
  )
})

test('groups are ordered by their own newest row, not by size or name', () => {
  // auth_zone's newest row (08:00) is older than subnetservice's (10:00), so
  // subnetservice sits above it even though both hold a single row.
  const groups = groupByResource(GROUPED)
  assert.deepEqual(
    groups.map((g) => g.newestTs),
    ['2026-08-06T11:00:00.000Z', '2026-08-06T10:00:00.000Z', '2026-08-06T08:00:00.000Z'],
  )
})

test('each group counts the rows listed under it, hand-checked', () => {
  const [address, subnet, zone] = groupByResource(GROUPED)
  assert.deepEqual({ total: address.total, successes: address.successes, failures: address.failures, deletions: address.deletions }, { total: 3, successes: 2, failures: 1, deletions: 1 })
  assert.deepEqual({ total: subnet.total, successes: subnet.successes, failures: subnet.failures, deletions: subnet.deletions }, { total: 1, successes: 1, failures: 0, deletions: 0 })
  assert.deepEqual({ total: zone.total, successes: zone.successes, failures: zone.failures, deletions: zone.deletions }, { total: 1, successes: 0, failures: 1, deletions: 0 })
})

test('a row with no resource is grouped under an explicit unknown label, not dropped', () => {
  // Dropping it would make the feed disagree with the row count above it.
  const groups = groupByResource([{ id: 'x', ts: '2026-08-06T11:00:00.000Z', result: 'success' }])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].resource, '(unknown resource)')
  assert.equal(groups[0].total, 1)
})

test('grouping nothing gives no groups rather than one empty one', () => {
  assert.deepEqual(groupByResource([]), [])
  assert.deepEqual(groupByResource(null), [])
})

// ---------- notability 1 + 2: deletions and non-success ----------

test('a deletion is any action spelled with "delete", whatever the case', () => {
  assert.equal(isDeletion({ action: 'DELETE' }), true)
  assert.equal(isDeletion({ action: 'delete' }), true)
  assert.equal(isDeletion({ action: 'DELETE_RANGE' }), true)
  assert.equal(isDeletion({ action: 'UPDATE' }), false)
  assert.equal(isDeletion({ action: 'BATCH' }), false)
  assert.equal(isDeletion({}), false)
})

test('anything that did not report success counts as a failed change', () => {
  assert.equal(isFailure({ result: 'success' }), false)
  assert.equal(isFailure({ result: 'SUCCESS' }), false)
  assert.equal(isFailure({ result: ' success ' }), false)
  assert.equal(isFailure({ result: 'failed: permission denied' }), true)
  // A blank result is not evidence of success. Reading it as success would
  // invent an outcome nobody checked, so it is listed and the caption says
  // "not reported successful" rather than "failed".
  assert.equal(isFailure({ result: '' }), true)
  assert.equal(isFailure({}), true)
})

// ---------- notability 3: out of hours ----------

// Built in LOCAL time on purpose: the boundary is the browser's own clock, so
// these timestamps carry the local hour under test whatever zone node runs in.
function localTs(hour, minute = 0) {
  return new Date(2026, 7, 6, hour, minute, 0).toISOString()
}

test('out of hours is 20:00 to 08:00 on the browser clock, both edges pinned', () => {
  assert.equal(isOutOfHours({ ts: localTs(19, 59) }), false, '19:59 is still working hours')
  assert.equal(isOutOfHours({ ts: localTs(20, 0) }), true, '20:00 is the first out-of-hours minute')
  assert.equal(isOutOfHours({ ts: localTs(23, 59) }), true)
  assert.equal(isOutOfHours({ ts: localTs(3, 21) }), true)
  assert.equal(isOutOfHours({ ts: localTs(7, 59) }), true, '07:59 is the last out-of-hours minute')
  assert.equal(isOutOfHours({ ts: localTs(8, 0) }), false, '08:00 is back inside working hours')
  assert.equal(isOutOfHours({ ts: localTs(12, 0) }), false)
})

test('a row with no usable ts is not claimed to be out of hours', () => {
  assert.equal(isOutOfHours({}), false)
  assert.equal(isOutOfHours({ ts: 'not a time' }), false)
})

// ---------- notability 4: first-time-seen actors ----------

// Six rows, three actors, spanning 06:00 to 11:30 UTC — a 5 h 30 m span whose
// midpoint is 08:45, worked out by hand and not by the code under test.
//   user-c  06:00, 08:00        earlier half only
//   user-a  07:00, 11:00        both halves
//   user-b  10:00, 11:30        recent half only  -> the only new actor
const ACTOR_ROWS = [
  { id: 'r1', ts: '2026-08-06T06:00:00.000Z', user: 'user-c', resource: 'z' },
  { id: 'r2', ts: '2026-08-06T07:00:00.000Z', user: 'user-a', resource: 'z' },
  { id: 'r3', ts: '2026-08-06T08:00:00.000Z', user: 'user-c', resource: 'z' },
  { id: 'r4', ts: '2026-08-06T10:00:00.000Z', user: 'user-b', resource: 'z' },
  { id: 'r5', ts: '2026-08-06T11:00:00.000Z', user: 'user-a', resource: 'z' },
  { id: 'r6', ts: '2026-08-06T11:30:00.000Z', user: 'user-b', resource: 'z' },
]

test('the observed span is the earliest and latest ts actually present', () => {
  const span = dataSpan(ACTOR_ROWS)
  assert.equal(span.earliestTs, '2026-08-06T06:00:00.000Z')
  assert.equal(span.latestTs, '2026-08-06T11:30:00.000Z')
  assert.equal(span.spanMs, 19800000) // 5 h 30 m in ms, hand-multiplied
  assert.equal(span.count, 6)
})

test('an actor is new only when it acts in the recent half and never in the earlier half', () => {
  // user-a acted in both halves and user-c only in the earlier one, so neither
  // is new. The naive "first row wins" rule would have marked all three.
  const out = newActors(ACTOR_ROWS, { truncated: false })
  assert.equal(out.status, 'ok')
  assert.deepEqual(out.actors, ['user-b'])
  assert.equal(out.midpointTs, '2026-08-06T08:45:00.000Z')
})

test('the rule is not vacuous: it refuses to mark every actor new', () => {
  // The guard this whole category exists for. Three actors are present and
  // exactly one is reported.
  const out = newActors(ACTOR_ROWS, { truncated: false })
  assert.equal(out.actors.length, 1)
  assert.notEqual(out.actors.length, 3)
})

test('the 500-row cap makes the earlier half unrepresentative, so the answer is "cannot tell"', () => {
  // Same rows, same span — only the cap flag differs. The oldest events inside
  // the window were dropped by the server, so an actor missing from the earlier
  // half might simply have been cut off.
  const out = newActors(ACTOR_ROWS, { truncated: true })
  assert.equal(out.status, 'unknown')
  assert.deepEqual(out.actors, [])
  assert.match(out.reason, /500/)
})

test('under two hours of data is also "cannot tell", not an empty list', () => {
  const out = newActors(
    [
      { ts: '2026-08-06T11:00:00.000Z', user: 'user-a' },
      { ts: '2026-08-06T12:00:00.000Z', user: 'user-b' },
    ],
    { truncated: false },
  )
  assert.equal(out.status, 'unknown')
  assert.deepEqual(out.actors, [])
  assert.match(out.reason, /2 hours/)
})

test('exactly two hours of data is enough — the guard is "under", not "at most"', () => {
  // 10:00 to 12:00 is a 2 h span, midpoint 11:00. user-a is in the earlier
  // half, user-b appears only after the midpoint.
  const out = newActors(
    [
      { ts: '2026-08-06T10:00:00.000Z', user: 'user-a' },
      { ts: '2026-08-06T11:00:00.000Z', user: 'user-a' },
      { ts: '2026-08-06T11:30:00.000Z', user: 'user-b' },
      { ts: '2026-08-06T12:00:00.000Z', user: 'user-a' },
    ],
    { truncated: false },
  )
  assert.equal(out.status, 'ok')
  assert.deepEqual(out.actors, ['user-b'])
})

test('an empty window cannot tell either — zero new actors would read as "none"', () => {
  assert.equal(newActors([], { truncated: false }).status, 'unknown')
  assert.equal(newActors(null, { truncated: false }).status, 'unknown')
})

test('a genuinely quiet recent half reports "none", not "cannot tell"', () => {
  // Enough history to answer, and the answer is zero. That is a real "none"
  // and must not be dressed up as missing history.
  const out = newActors(
    [
      { ts: '2026-08-06T09:00:00.000Z', user: 'user-a' },
      { ts: '2026-08-06T10:00:00.000Z', user: 'user-a' },
      { ts: '2026-08-06T12:00:00.000Z', user: 'user-a' },
    ],
    { truncated: false },
  )
  assert.equal(out.status, 'ok')
  assert.deepEqual(out.actors, [])
})

// ---------- the band as a whole ----------

test('the band always renders four categories, in the locked order', () => {
  const band = notability(ACTOR_ROWS, { truncated: false })
  assert.deepEqual(
    band.map((c) => c.key),
    ['deletions', 'failures', 'outOfHours', 'newActors'],
  )
})

test('every category carries a caption that states its rule in words', () => {
  const band = notability(ACTOR_ROWS, { truncated: false })
  for (const cell of band) assert.ok(cell.caption.length > 20, `${cell.key} has no caption`)
  const ooh = band.find((c) => c.key === 'outOfHours')
  assert.match(ooh.caption, /20:00/)
  assert.match(ooh.caption, /08:00/)
  assert.match(ooh.caption, /local/i)
  const actors = band.find((c) => c.key === 'newActors')
  assert.match(actors.caption, /half/i)
})

test('an empty category says "none" explicitly rather than disappearing', () => {
  const band = notability(
    [{ ts: '2026-08-06T12:00:00.000Z', user: 'user-a', action: 'UPDATE', result: 'success', resource: 'z' }],
    { truncated: false },
  )
  const del = band.find((c) => c.key === 'deletions')
  assert.equal(del.count, 0)
  assert.equal(del.state, 'none')
  assert.equal(del.chip, 'None')
})

test('band counts on a hand-built window match a hand count', () => {
  // 12:00 local is inside working hours in every zone, so the out-of-hours
  // count below is driven only by the two rows built at 21:00 and 02:00 local.
  const rows = [
    { ts: localTs(12, 0), user: 'u1', action: 'DELETE', result: 'success', resource: 'z' },
    { ts: localTs(12, 1), user: 'u1', action: 'UPDATE', result: 'failed: denied', resource: 'z' },
    { ts: localTs(21, 0), user: 'u2', action: 'UPDATE', result: 'success', resource: 'z' },
    { ts: localTs(2, 0), user: 'u2', action: 'DELETE', result: 'failed: denied', resource: 'z' },
  ]
  const band = notability(rows, { truncated: false })
  const count = (key) => band.find((c) => c.key === key).count
  assert.equal(count('deletions'), 2)
  assert.equal(count('failures'), 2)
  assert.equal(count('outOfHours'), 2)
})

// ---------- the 500-row cap ----------

test('a truncated response raises the cap banner and names the number', () => {
  const notice = capNotice({ truncated: true, count: 500, rows: [] })
  assert.equal(notice.capped, true)
  assert.equal(notice.cap, 500)
  assert.match(notice.text, /500/)
})

test('the banner never promises "everything that changed"', () => {
  // The screen can only promise the 500 most recent events inside 24 h. Any
  // wording stronger than that is a claim the server cannot back.
  const notice = capNotice({ truncated: true, count: 500, rows: [] })
  assert.match(notice.text, /most recent/i)
  assert.doesNotMatch(notice.text, /everything/i)
  assert.doesNotMatch(notice.text, /\ball\b/i)
})

test('an untruncated response raises no banner at all', () => {
  assert.equal(capNotice({ truncated: false, rows: [] }).capped, false)
  assert.equal(capNotice({ rows: [] }).capped, false)
  assert.equal(capNotice(null).capped, false)
  assert.equal(capNotice({ truncated: 'true' }).capped, false, 'only a real boolean counts as capped')
})

// ---------- the span bar ----------

test('a duration prints as zero-padded hours, minutes and seconds', () => {
  assert.equal(formatDuration(0), '00:00:00')
  assert.equal(formatDuration(19800000), '05:30:00') // 5 h 30 m
  assert.equal(formatDuration(51872000), '14:24:32') // 14 h 24 m 32 s
  assert.equal(formatDuration(86400000), '24:00:00') // the whole window
})

test('a clock reads in the browser local zone, matching the out-of-hours rule', () => {
  assert.equal(formatClock(localTs(3, 21)), '03:21:00')
  assert.equal(formatClock(localTs(21, 5)), '21:05:00')
  assert.equal(formatClock('junk'), '—')
})

// The date printed beside the clock has to be read in the SAME zone the clock
// is, and `node --test` inherits whatever zone the machine is set to — so a
// test written for one office would pass there and nowhere else. Each case
// below pins TZ around the call itself. Assigning process.env.TZ re-reads the
// zone for Dates constructed afterwards (node 24), and formatDate/formatClock
// both parse inside the call, so the pin covers the parse. The previous value
// is put back so the rest of this file still runs in the machine's own zone.
function withTZ(tz, fn) {
  const before = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

test('the date beside the clock is the local date, so both halves of one timestamp agree', () => {
  // New York is UTC-4 in August, so 2026-08-07T01:26:00Z is 21:26 on the
  // EVENING OF THE 6TH there. Slicing the ISO string would print 2026-08-07
  // beside a 21:26 clock — the same event dated a day into the future on a
  // screen whose whole job is "what changed in the last 24 hours". Both
  // literals are written out from that offset by hand.
  withTZ('America/New_York', () => {
    assert.equal(formatClock('2026-08-07T01:26:00.000Z'), '21:26:00')
    assert.equal(formatDate('2026-08-07T01:26:00.000Z'), '2026-08-06')
  })
})

test('the date follows the clock across the other midnight too', () => {
  // The mirror case, so the fix cannot be "always subtract a day". Tokyo is
  // UTC+9, so 2026-08-06T22:10:00Z is 07:10 on the 7th there and the date runs
  // one day AHEAD of the ISO string rather than behind it.
  withTZ('Asia/Tokyo', () => {
    assert.equal(formatClock('2026-08-06T22:10:00.000Z'), '07:10:00')
    assert.equal(formatDate('2026-08-06T22:10:00.000Z'), '2026-08-07')
  })
})

test('the date pads to yyyy-mm-dd and refuses a ts it cannot read', () => {
  withTZ('UTC', () => {
    // Single-digit month and day, so the padding is proved rather than assumed.
    assert.equal(formatDate('2026-01-02T00:00:00.000Z'), '2026-01-02')
  })
  // Same em dash the clock falls back to, so a row with no usable ts shows a
  // gap in both lanes instead of half a timestamp.
  assert.equal(formatDate(''), '—')
  assert.equal(formatDate('yesterday-ish'), '—')
  assert.equal(formatDate(undefined), '—')
})

test('the span bar states its own arithmetic over the rows actually listed', () => {
  const summary = feedSummary(ACTOR_ROWS)
  assert.equal(summary.listed, 6)
  assert.equal(summary.groups, 1) // all six rows carry resource "z"
  assert.equal(summary.spanText, '05:30:00') // 06:00 to 11:30, hand-subtracted
  assert.equal(summary.earliestClock, formatClock('2026-08-06T06:00:00.000Z'))
  assert.equal(summary.latestClock, formatClock('2026-08-06T11:30:00.000Z'))
})

test('an empty feed has a summary rather than a crash', () => {
  const summary = feedSummary([])
  assert.equal(summary.listed, 0)
  assert.equal(summary.groups, 0)
  assert.equal(summary.spanText, '00:00:00')
  assert.equal(summary.earliestClock, '—')
})

// ---------- availability ----------

test('a failed fetch is unavailable, never an empty window', () => {
  // csp.go answers HTTP 200 with {rows:[],count:0,status:"error"} on an
  // upstream failure. Rendering that as "nothing changed" would be a lie the
  // size of the whole tenant.
  assert.equal(feedState({ payload: { rows: [], status: 'error' }, rowsInWindow: [] }), 'unavailable')
  assert.equal(feedState({ error: new Error('500'), payload: null, rowsInWindow: [] }), 'unavailable')
  assert.equal(feedState({ payload: null, rowsInWindow: [] }), 'unavailable')
})

test('loading beats every other state so no verdict is shown mid-flight', () => {
  assert.equal(feedState({ loading: true, payload: null, rowsInWindow: [] }), 'loading')
  assert.equal(feedState({ loading: true, error: new Error('x'), rowsInWindow: [] }), 'loading')
})

test('a healthy but quiet window is empty, and a populated one is ok', () => {
  assert.equal(feedState({ payload: { rows: [], status: 'ok' }, rowsInWindow: [] }), 'empty')
  assert.equal(feedState({ payload: { rows: [{}], status: 'ok' }, rowsInWindow: [{}] }), 'ok')
})

test('rows that all fell outside the 24 h window read as empty, not as rows', () => {
  // The server returned rows; none survived the window filter. There is
  // nothing to draw, and nothing broke.
  assert.equal(feedState({ payload: { rows: [{}, {}], status: 'ok' }, rowsInWindow: [] }), 'empty')
})

test('the truncated cap turns the new-actor cell unknown but leaves the other three counted', () => {
  const band = notability(ACTOR_ROWS.map((r) => ({ ...r, action: 'DELETE', result: 'success' })), { truncated: true })
  assert.equal(band.find((c) => c.key === 'deletions').count, 6)
  assert.equal(band.find((c) => c.key === 'deletions').state, 'populated')
  const actors = band.find((c) => c.key === 'newActors')
  assert.equal(actors.state, 'unknown')
  assert.equal(actors.chip, 'Unknown')
})
