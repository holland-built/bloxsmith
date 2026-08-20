// Run with: npm test  (node --test, no test framework dependency)
//
// The wording rules for issue #157. Every case here is a sentence a person
// reads off a panel, so the assertions are the exact strings rather than a
// shape — a test asserting "contains the number" would pass on "50 events",
// which is the wrong answer this file exists to keep off the screen.

import assert from 'node:assert/strict'
import test from 'node:test'
import { isSample, knownTotal, sampleCountLabel, sampleScopeNote, totalEventsTile } from './sampleCount.js'

const COMPLETE = { returned: 7, truncated: false, total: 7 }
const CAPPED_WITH_TOTAL = { returned: 50, truncated: true, total: 1204 }
const CAPPED_NO_TOTAL = { returned: 50, truncated: true }
const COMPLETE_NO_TOTAL = { returned: 7, truncated: false }

test('a complete window is stated plainly, with no hedging', () => {
  assert.equal(sampleCountLabel(COMPLETE, 'events'), '7 events')
  assert.equal(sampleScopeNote(COMPLETE, 'events'), null)
  assert.equal(isSample(COMPLETE), false)
})

test('a capped window with a real total names both numbers', () => {
  assert.equal(sampleCountLabel(CAPPED_WITH_TOTAL, 'events'), '50 of 1,204 events')
  assert.equal(
    sampleScopeNote(CAPPED_WITH_TOTAL, 'events'),
    'Counted from the 50 of 1,204 events shown, not the whole window.',
  )
})

test('a capped window with no total says the total is unknown, never a bare count', () => {
  // The whole defect in one assertion: this must not come back "50 events".
  assert.equal(sampleCountLabel(CAPPED_NO_TOTAL, 'events'), '50 events shown, total unknown')
  assert.equal(
    sampleScopeNote(CAPPED_NO_TOTAL, 'events'),
    'Counted from the 50 events shown, not the whole window.',
  )
})

test('a total is only believed when the server actually published a number', () => {
  assert.equal(knownTotal(CAPPED_NO_TOTAL), null)
  assert.equal(knownTotal({ returned: 5, truncated: true, total: null }), null)
  assert.equal(knownTotal({ returned: 5, truncated: true, total: '1204' }), null, 'a string is not a total')
  assert.equal(knownTotal({ returned: 5, truncated: true, total: 1204 }), 1204)
})

test('the total tile stops calling itself a total when it does not have one', () => {
  assert.deepEqual(totalEventsTile(CAPPED_WITH_TOTAL, 'Total Events', 'Events Shown'), {
    label: 'Total Events',
    value: 1204,
  })
  // The live 2026-08-20 case: 50 rows, cap hit, no total published. The old
  // code rendered "Total Events 50" here.
  assert.deepEqual(totalEventsTile(CAPPED_NO_TOTAL, 'Total Events', 'Events Shown'), {
    label: 'Events Shown',
    value: 50,
  })
  // Nothing was cut, so the rows in hand ARE the window and "total" is honest
  // even though upstream published no figure.
  assert.deepEqual(totalEventsTile(COMPLETE_NO_TOTAL, 'Total Events', 'Events Shown'), {
    label: 'Total Events',
    value: 7,
  })
})

// THE REGRESSION THE page-baseline SUITE CAUGHT. The first version of
// sampleCount.js read `data.returned` and nothing else, so a payload predating
// that field rendered "0 events" on a page showing two. That payload is not
// hypothetical: a browser tab open across a deploy holds it, and so does a
// cached response. Replacing a wrong number on a security panel with a worse
// one, for everybody who had not reloaded, is a strictly worse bug than the one
// being fixed.
test('a payload from before `returned` existed still counts its rows', () => {
  const OLD_SHAPE = { events: [{ severity: 'high' }, { severity: 'low' }], counts: {}, blocked: 1 }
  assert.equal(sampleCountLabel(OLD_SHAPE, 'events'), '2 events')
  // No `truncated` either, so it takes the unqualified branch and reads exactly
  // as it did before any of this changed. That is the point: the row count is
  // only dangerous when something LABELS it a total.
  assert.equal(sampleScopeNote(OLD_SHAPE, 'events'), null)
  assert.deepEqual(totalEventsTile(OLD_SHAPE, 'Total Events', 'Events Shown'), {
    label: 'Total Events',
    value: 2,
  })
})

test('a missing or half-built payload counts nothing rather than guessing', () => {
  assert.equal(sampleCountLabel(undefined, 'events'), '0 events')
  assert.equal(sampleCountLabel({}, 'events'), '0 events')
  assert.equal(sampleScopeNote(undefined, 'events'), null)
  assert.deepEqual(totalEventsTile(undefined, 'Total Events', 'Events Shown'), {
    label: 'Total Events',
    value: 0,
  })
})

test('an incoherent payload is not rescued here — the server drops bad totals', () => {
  // The server already refuses a total smaller than the rows it returned
  // (go/internal/dashboard/hub.go). If one ever arrives anyway, it is rendered
  // as given rather than silently repaired, so the bug is visible at its
  // source instead of being masked in two places.
  assert.equal(sampleCountLabel({ returned: 50, truncated: true, total: 3 }, 'events'), '50 of 3 events')
})
