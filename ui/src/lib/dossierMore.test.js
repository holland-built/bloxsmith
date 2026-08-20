// Run with: npm test  (node --test, no test framework dependency)
//
// The three payload shapes go/internal/server/search.go can emit, and the
// wording each one is allowed to produce. Exact strings, not shapes: a test
// asserting "mentions a number" would pass on the wrong number, which is the
// entire defect (#153).

import assert from 'node:assert/strict'
import test from 'node:test'
import { dossierMoreLine } from './dossierMore.js'

const MAX_ROWS = 6

test('nothing was capped: the rows in hand are everything, so the arithmetic stands', () => {
  // searchFetch returns {truncated: false, limit: 50} for an uncapped search.
  const body = { truncated: false, limit: 50 }
  assert.equal(
    dossierMoreLine(body, 9, MAX_ROWS),
    '3 more results not shown here — this ledger shows one line per result.',
  )
  assert.equal(dossierMoreLine(body, 6, MAX_ROWS), null, 'nothing hidden, nothing to say')
  assert.equal(dossierMoreLine(body, 2, MAX_ROWS), null)
})

test('one hidden result is singular', () => {
  assert.equal(
    dossierMoreLine({ truncated: false }, 7, MAX_ROWS),
    '1 more result not shown here — this ledger shows one line per result.',
  )
})

test('an authoritative total is measured against everything that matched', () => {
  // searchFetch returns {total, limit} when upstream published a count. The
  // page received 50 rows and drew 6; the honest hidden count is 494, not 44.
  assert.equal(
    dossierMoreLine({ total: 500, limit: 50 }, 50, MAX_ROWS),
    '494 more results not shown here — this ledger shows one line per result.',
  )
  assert.equal(
    dossierMoreLine({ total: 1204, limit: 50 }, 50, MAX_ROWS),
    '1,198 more results not shown here — this ledger shows one line per result.',
  )
})

test('THE DEFECT: capped with no total states no number at all', () => {
  // This is the case that produced "44 more results" for a query matching 500.
  // The count of what arrived must not be dressed up as the count of what
  // matched, so the line states there are more and says why the number is not
  // knowable.
  const line = dossierMoreLine({ truncated: true, limit: 50 }, 50, MAX_ROWS)
  assert.equal(
    line,
    'More results not shown here — the search stopped at the first 50, so the number left over is unknown.',
  )
  assert.doesNotMatch(line, /\b44\b/, 'the rows-in-hand arithmetic must not appear')
})

test('capped with no limit published still refuses to invent a number', () => {
  assert.equal(
    dossierMoreLine({ truncated: true }, 50, MAX_ROWS),
    'More results not shown here — the search was capped, so the number left over is unknown.',
  )
})

test('a total that is not larger than what is drawn is not a claim about hidden rows', () => {
  // total === shown means everything that matched is on screen. Falling through
  // to the truncated branch would then be wrong in the opposite direction.
  assert.equal(dossierMoreLine({ total: 6, limit: 50 }, 6, MAX_ROWS), null)
  assert.equal(dossierMoreLine({ total: 3, limit: 50 }, 3, MAX_ROWS), null)
})

test('an authoritative total wins over the truncated flag', () => {
  // Both can be present. The total is the better answer and the flag adds
  // nothing once a real count is known.
  assert.equal(
    dossierMoreLine({ total: 500, truncated: true, limit: 50 }, 50, MAX_ROWS),
    '494 more results not shown here — this ledger shows one line per result.',
  )
})

test('a malformed total is ignored rather than rendered', () => {
  // A string is not a total. Falls back to the flag, which is the honest answer —
  // and if the flag is absent too, to the rows in hand.
  assert.equal(
    dossierMoreLine({ total: '500', truncated: true, limit: 50 }, 50, MAX_ROWS),
    'More results not shown here — the search stopped at the first 50, so the number left over is unknown.',
  )
  assert.equal(
    dossierMoreLine({ total: null }, 9, MAX_ROWS),
    '3 more results not shown here — this ledger shows one line per result.',
  )
})

test('a missing body behaves like an uncapped search', () => {
  // A section that errored has no body, and its "more results" line is not
  // rendered at all — but the helper must not throw if it is ever called.
  assert.equal(dossierMoreLine(null, 0, MAX_ROWS), null)
  assert.equal(dossierMoreLine(undefined, 8, MAX_ROWS), '2 more results not shown here — this ledger shows one line per result.')
})
