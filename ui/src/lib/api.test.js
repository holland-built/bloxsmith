// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { COLD_TIMEOUT_MS, WARM_TIMEOUT_MS, abortAfter, budgetMs } from './api.js'

// The slowest cold /api/data measured against the live tenant (3 samples:
// 17.1 / 23.0 / 25.8s). The first load must survive at least this long.
const MEASURED_WORST_COLD_MS = 25800

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

test('the cold budget is the only one that exceeds the measured worst case', () => {
  assert.ok(
    COLD_TIMEOUT_MS > MEASURED_WORST_COLD_MS,
    'cold budget must exceed the slowest measured cold load',
  )
  assert.ok(
    WARM_TIMEOUT_MS < MEASURED_WORST_COLD_MS,
    'warm budget must stay tight — a warm read is 0.02s, so a slow one is a hang',
  )
  assert.equal(budgetMs(false), COLD_TIMEOUT_MS)
  assert.equal(budgetMs(true), WARM_TIMEOUT_MS)
})
