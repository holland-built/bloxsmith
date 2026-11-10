// Run with: npm test  (node --test, no test framework dependency)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { order, splitCount, tally } from './bestPractices.js'

const c = (id, status, severity = 'high', extra = {}) => ({ id, status, severity, title: id, items: [], ...extra })

test('counts problems, couldn\'t tell and passed from the same list, and never counts an odd status as passed', () => {
  const t = tally([c('a', 'problem'), c('b', 'problem', 'medium'), c('c', 'unknown'), c('d', 'passed'), c('e', 'weird')])
  assert.deepEqual(t, { total: 5, problems: 2, unknown: 2, passed: 1, bySev: [['high', 1], ['medium', 1]] })
})

test('orders problems, then couldn\'t tell (any status that is not passed), then passed', () => {
  const ids = order([c('p', 'passed'), c('w', 'weird'), c('m', 'problem', 'medium'), c('h', 'problem'), c('u', 'unknown', 'low')]).map((x) => x.id)
  assert.deepEqual(ids, ['h', 'm', 'w', 'u', 'p'])
})

test('pulls the count out of the front of a problem title only when it matches the items', () => {
  const items = [{}, {}]
  assert.deepEqual(splitCount({ title: '2 on-prem hosts are offline', items }), { n: 2, rest: 'on-prem hosts are offline' })
  assert.deepEqual(splitCount({ title: '3 things', items }), { n: 2, rest: '3 things' })
  assert.deepEqual(splitCount({ title: 'Something wrong', items: [] }), { n: null, rest: 'Something wrong' })
})
