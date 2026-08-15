import test from 'node:test'
import assert from 'node:assert/strict'
import { feedCountLabel, feedCountTitle } from './feedCount.js'

// The Host Health card printed "500" for an estate the server had already
// measured at 532 (#85). The number was the request limit wearing the costume
// of a fact about the tenant. These tests pin both halves: the qualified count
// appears when — and only when — the server proved it was owed.

test('a plain feed is unchanged: the count is the rows on screen', () => {
  assert.equal(feedCountLabel({ rows: [], status: 'ok' }, 40), '40')
})

test('a truncated feed says what it is out of', () => {
  assert.equal(feedCountLabel({ truncated: true, total_available: 532 }, 500), '500 of 532')
})

test('large numbers keep their thousands separators on both sides', () => {
  assert.equal(feedCountLabel({ truncated: true, total_available: 12345 }, 1000), '1,000 of 12,345')
})

test('the flag alone is not enough — a total that is not larger prints plainly', () => {
  assert.equal(feedCountLabel({ truncated: true, total_available: 500 }, 500), '500')
  assert.equal(feedCountLabel({ truncated: true, total_available: 400 }, 500), '500')
})

test('a total with no flag is not a truncation claim', () => {
  assert.equal(feedCountLabel({ total_available: 532 }, 500), '500')
})

test('a missing or unusable total never invents a denominator', () => {
  assert.equal(feedCountLabel({ truncated: true }, 500), '500')
  assert.equal(feedCountLabel({ truncated: true, total_available: null }, 500), '500')
  assert.equal(feedCountLabel({ truncated: true, total_available: 'lots' }, 500), '500')
})

test('nothing to count means nothing on screen, not a zero', () => {
  assert.equal(feedCountLabel({ rows: [] }, 0), null)
  assert.equal(feedCountLabel(undefined, 0), null)
  assert.equal(feedCountLabel(undefined, NaN), null)
})

test('an absent payload still counts the rows it was handed', () => {
  assert.equal(feedCountLabel(undefined, 3), '3')
})

test('the tooltip explains a qualified count and stays out of the way otherwise', () => {
  const reason = 'host list truncated at the 1000-row limit — the estate is larger than the rows shown'
  assert.equal(feedCountTitle({ truncated: true, total_available: 532, reason }, 500), reason)
  assert.equal(feedCountTitle({ truncated: true, total_available: 532 }, 500), undefined)
  assert.equal(feedCountTitle({ rows: [] }, 40), undefined)
})
