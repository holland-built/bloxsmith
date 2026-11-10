// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { rankTypes, seenAgo, shareText, typeTotal, unclassifiedCount } from './assetTypes.js'

// Expected answers worked out by hand, not with the module's own arithmetic.
const TYPES = [
  { label: 'Router', count: 38 },
  { label: 'Unclassified', count: 636 },
  { label: 'Server', count: 64 },
  { label: 'Cloud Security Group', count: 516 },
  { label: 'Tablet', count: 1 },
  { label: 'Firewall', count: 1 },
]
const labels = (rows) => rows.map((t) => t.label)

test('rankTypes puts the largest first, ties A to Z', () => {
  const { shown } = rankTypes(TYPES, 2204, { top: 10 })
  assert.deepEqual(labels(shown), ['Unclassified', 'Cloud Security Group', 'Server', 'Router', 'Firewall', 'Tablet'])
})

test('rankTypes shows the top N and counts the rest', () => {
  const r = rankTypes(TYPES, 2204, { top: 3 })
  assert.deepEqual(labels(r.shown), ['Unclassified', 'Cloud Security Group', 'Server'])
  assert.equal(r.hidden, 3)
})

test('rankTypes keeps a chosen type in view when it is outside the top N', () => {
  const r = rankTypes(TYPES, 2204, { top: 3, active: 'Tablet' })
  assert.deepEqual(labels(r.shown), ['Unclassified', 'Cloud Security Group', 'Server', 'Tablet'])
  assert.equal(r.hidden, 2)
})

test('rankTypes gives each type its share of the total', () => {
  const { shown } = rankTypes(TYPES, 2204, { top: 1 })
  assert.ok(Math.abs(shown[0].share - 0.2886) < 0.0001)
})

test('shareText reads shares the way people say them', () => {
  assert.equal(shareText(636, 2204), '29%')
  assert.equal(shareText(5, 2204), '0.2%')
  assert.equal(shareText(1, 5000), '<0.1%') // never "0.0%" for a real asset
  assert.equal(shareText(5, null), '')
})

test('typeTotal uses the feed total, else the sum of the types', () => {
  assert.equal(typeTotal({ total: 2204, types: TYPES }), 2204)
  assert.equal(typeTotal({ total: null, types: TYPES }), 1256)
  assert.equal(typeTotal({ total: null, types: [] }), null)
})

test('unclassifiedCount: a count, a real zero, or unknown', () => {
  assert.equal(unclassifiedCount({ types: TYPES }), 636)
  assert.equal(unclassifiedCount({ types: [{ label: 'Server', count: 2 }] }), 0)
  assert.equal(unclassifiedCount(undefined), null)
})

test('seenAgo reads a zoneless cube time as UTC and says how long ago', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  assert.equal(seenAgo('2026-01-01T04:00:00.000', now), '8h ago')
  assert.equal(seenAgo('2026-01-01T11:35:00Z', now), '25m ago')
  assert.equal(seenAgo('2025-12-29T12:00:00Z', now), '3d ago')
  assert.equal(seenAgo('', now), null)
})

test('typeTotal is unknown when any type count is missing, never a partial sum', () => {
  assert.equal(typeTotal({ total: null, types: [{ label: 'Unclassified', count: 10 }, { label: 'Server', count: null }] }), null)
  assert.equal(typeTotal({ types: [] }), null)
})
