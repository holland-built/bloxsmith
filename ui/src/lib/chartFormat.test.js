// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { dnssecPanelLabel, fmtShortDay, fmtValue } from './chartFormat.js'

// The pure half of the chart-honesty work. Everything a tooltip has to DECIDE
// lives here so it can be tested; the JSX that draws the tooltip (ChartTip in
// ui/src/components/ui.jsx) cannot be — this repo runs node --test with no JSX
// transform, and adding one to unit-test one component is a worse trade than
// covering it from tests/chart-tooltips.spec.ts in a real browser.
//
// The reader these functions serve is a network operator, not a React
// developer. That single fact decides every case below: `346.1144444444444` is
// a float that leaked out of an average, not a measurement anyone took, so it
// reads 346.1; 14212342 reads 14,212,342 because nobody counts digits; and
// 2026-08-01T00:00:00.000 reads "Aug 1" because that is how people say dates.

test('fmtValue writes whole numbers with thousands separators', () => {
  assert.equal(fmtValue(14212342), '14,212,342')
  assert.equal(fmtValue(312011), '312,011')
  assert.equal(fmtValue(1), '1')
  assert.equal(fmtValue(0), '0')
  assert.equal(fmtValue(-4200), '-4,200')
})

test('fmtValue keeps at most one decimal place on a fraction', () => {
  // The exact leak this whole change exists to kill (Overview dns-hero).
  assert.equal(fmtValue(346.1144444444444), '346.1')
  assert.equal(fmtValue(274.715), '274.7')
  assert.equal(fmtValue(0.04), '0')
  assert.equal(fmtValue(2.5), '2.5')
  // Rounds to a whole number: no trailing ".0" a person would never write.
  assert.equal(fmtValue(9.98), '10')
  assert.equal(fmtValue(1234.56), '1,234.6')
})

test('fmtValue never invents a number it was not given', () => {
  assert.equal(fmtValue(null), '—')
  assert.equal(fmtValue(undefined), '—')
  assert.equal(fmtValue(''), '—')
  assert.equal(fmtValue('not a number'), '—')
  assert.equal(fmtValue(NaN), '—')
  assert.equal(fmtValue(Infinity), '—')
})

test('fmtValue reads a numeric string, because feeds send both', () => {
  assert.equal(fmtValue('312011'), '312,011')
  assert.equal(fmtValue('346.1144444444444'), '346.1')
})

test('fmtShortDay turns an ISO timestamp into the way people say a date', () => {
  assert.equal(fmtShortDay('2026-08-01T00:00:00.000'), 'Aug 1')
  assert.equal(fmtShortDay('2026-08-01T00:00:00.000Z'), 'Aug 1')
  assert.equal(fmtShortDay('2026-07-31T00:00:00.000'), 'Jul 31')
  assert.equal(fmtShortDay('2026-01-28'), 'Jan 28')
})

test('fmtShortDay passes an already-human label straight through', () => {
  // Overview's DNS hero and Security's threat events label their points with a
  // clock time, not a date. Those are already readable and must not be mangled
  // into "Invalid Date" by a Date constructor that cannot parse them.
  assert.equal(fmtShortDay('03:00 PM'), '03:00 PM')
  assert.equal(fmtShortDay('1:00'), '1:00')
  assert.equal(fmtShortDay('CREATE'), 'CREATE')
  assert.equal(fmtShortDay('01-27'), '01-27')
})

test('fmtShortDay says nothing rather than something wrong', () => {
  assert.equal(fmtShortDay(null), '')
  assert.equal(fmtShortDay(undefined), '')
  assert.equal(fmtShortDay(''), '')
  // A bare array index is the dns-query-volume-7d bug: `r.hour ?? i` fell
  // through to 0..6 because the live rows carry `timestamp`. A number reaching
  // this function is never a date, and must never be printed as one.
  assert.equal(fmtShortDay(0), '')
  assert.equal(fmtShortDay(3), '')
})

test('dnssecPanelLabel says how many it is showing and out of what', () => {
  // Capped: the panel shows the first `cap` of a longer list.
  assert.equal(dnssecPanelLabel(1204, 150), 'first 150 of 1,204 unsigned (A–Z)')
  assert.equal(dnssecPanelLabel(151, 150), 'first 150 of 151 unsigned (A–Z)')
})

test('dnssecPanelLabel drops the "first N of" when nothing is cut', () => {
  assert.equal(dnssecPanelLabel(150, 150), '150 unsigned')
  assert.equal(dnssecPanelLabel(3, 150), '3 unsigned')
  assert.equal(dnssecPanelLabel(1, 150), '1 unsigned')
})

test('dnssecPanelLabel says nothing when there is nothing to say', () => {
  assert.equal(dnssecPanelLabel(0, 150), '')
  assert.equal(dnssecPanelLabel(null, 150), '')
  assert.equal(dnssecPanelLabel(undefined, 150), '')
})

test('dnssecPanelLabel never says "worst"', () => {
  // The word it replaces. The rows carry fqdn/view/status/policy and nothing
  // that ranks severity, so "worst 150" was a claim the data cannot support —
  // it was upstream order. A–Z at least makes the cut deterministic and says
  // out loud which 150 you are looking at.
  for (const n of [0, 1, 150, 151, 20000]) {
    assert.ok(!/worst/i.test(dnssecPanelLabel(n, 150)), `n=${n} still says "worst"`)
  }
})
