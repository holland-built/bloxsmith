// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { COLD_TIMEOUT_MS, WARM_TIMEOUT_MS, abortAfter, budgetMs } from './api.js'

// The slowest cold /api/data measured against the live tenant.
//
// This was 25_800 — the worst of three samples (17.1 / 23.0 / 25.8s) taken
// before v3.45.0 split the one 5,000-row subnet read into ten concurrent
// 500-row ones. Re-measured 2026-08-02 on a freshly restarted binary, 13 kept
// samples: 3.53 3.60 3.62 3.74 3.77 3.77 3.78 3.82 4.00 4.08 4.13 4.15 7.49s,
// median 3.78. The old 17-26s timings do not reproduce at all, so the constant
// was stale evidence, not a requirement the budget had to keep meeting.
//
// 7_490 is the WORST kept sample, not the median, because that is what the
// budget has to survive. It was taken on a loaded machine (concurrent builds),
// so it is pessimistic if anything.
const MEASURED_WORST_COLD_MS = 7490

// The slowest warm read measured in the same run (/api/data 0.011-0.036s,
// /api/incidents 0.008-0.018s). Rounded up to a whole millisecond.
const MEASURED_WORST_WARM_MS = 36

test('a cold request is still alive at the slowest measured cold load', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { signal } = abortAfter(budgetMs(false))
  let aborted = false
  signal.addEventListener('abort', () => {
    aborted = true
  })

  t.mock.timers.tick(MEASURED_WORST_COLD_MS)

  assert.equal(
    aborted,
    false,
    `cold budget aborted at ${MEASURED_WORST_COLD_MS}ms, which a real first load takes`,
  )
  assert.equal(signal.aborted, false)
})

test('a cold request is aborted once the cold budget elapses', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { signal } = abortAfter(budgetMs(false))

  t.mock.timers.tick(COLD_TIMEOUT_MS - 1)
  assert.equal(signal.aborted, false, 'aborted one tick early')

  t.mock.timers.tick(1)
  assert.equal(signal.aborted, true, 'a hung feed would never be cut off')
})

test('a warm request keeps the original 12s hang guard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { signal } = abortAfter(budgetMs(true))

  t.mock.timers.tick(WARM_TIMEOUT_MS - 1)
  assert.equal(signal.aborted, false)

  t.mock.timers.tick(1)
  assert.equal(signal.aborted, true)
  assert.equal(WARM_TIMEOUT_MS, 12000, 'the hung-feed guard was 12s and stays 12s')
})

test('cancel stops a finished request from being aborted later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { signal, cancel } = abortAfter(budgetMs(false))
  cancel()

  t.mock.timers.tick(COLD_TIMEOUT_MS * 2)
  assert.equal(signal.aborted, false)
})

test('both budgets clear their measured worst case, and cold is never the tighter one', () => {
  assert.ok(
    COLD_TIMEOUT_MS > MEASURED_WORST_COLD_MS,
    'cold budget must exceed the slowest measured cold load',
  )
  assert.ok(
    WARM_TIMEOUT_MS > MEASURED_WORST_WARM_MS * 100,
    'warm budget must stay far above a real warm read, so a slow one reads as a hang',
  )
  // Cold is by construction the slower path, so its budget can never be the
  // tighter of the two. This is the invariant that used to be expressed as
  // "warm < the worst cold sample" — true only while the cold path was slow
  // enough for that comparison to mean anything. Now that the worst cold load
  // (7.5s) is under the warm guard (12s), the documented rule of worst + one
  // observed spread yields 11.6s, which would put cold BELOW warm. It is
  // therefore floored at the warm guard, and this assertion pins that floor.
  assert.ok(
    COLD_TIMEOUT_MS >= WARM_TIMEOUT_MS,
    'a cold budget tighter than the warm one is meaningless',
  )
  assert.equal(budgetMs(false), COLD_TIMEOUT_MS)
  assert.equal(budgetMs(true), WARM_TIMEOUT_MS)
})
