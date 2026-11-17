// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { pageState } from './itemPaging.js'

// /api/item answers one page at a time. A cut-off list must say so and offer
// the rest; a whole list must not offer more.
test('a known total says how many of how many, and whether more can load', () => {
  assert.deepEqual(pageState({ total: 73, limit: 50 }, 50), { total: 73, more: true, count: '50 of 73' })
  assert.deepEqual(pageState({ total: 73, limit: 50 }, 73), { total: 73, more: false, count: '73' })
  assert.deepEqual(pageState({ total: 3 }, 3), { total: 3, more: false, count: '3' })
})

test('with no total, a full page says more exist rather than looking complete', () => {
  assert.deepEqual(pageState({ truncated: true, limit: 50 }, 50), { total: null, more: true, count: '50 so far, more to load' })
  assert.deepEqual(pageState({ truncated: false, limit: 50 }, 12), { total: null, more: false, count: '12' })
  assert.deepEqual(pageState(null, 0), { total: null, more: false, count: '0' })
})
