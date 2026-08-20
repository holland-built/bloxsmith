// Run with: npm test  (node --test, no test framework dependency)
//
// The Security Inventory panel's numbers, and the four different things a
// missing one can mean. /api/hub/domains carries a per-section availability map
// precisely so one dead feed cannot blank the panel or, worse, render as a row
// of zeros — and its sections are deliberately not all the same shape, which is
// where a generic "count the array" reader goes wrong.

import assert from 'node:assert/strict'
import test from 'node:test'
import { inventoryRow } from './securityInventory.js'

// Trimmed from the real payload, live tenant, 2026-08-20.
const LIVE = {
  security_policies: [{}, {}, {}],
  threat_feeds: new Array(30).fill({}),
  named_lists: new Array(11).fill({}),
  roaming_endpoints: { total: 9, by_status: { unknown: 9 }, top_countries: [['india', 8]] },
  anycast_ha: [],
  availability: {
    security_policies: 'ok',
    threat_feeds: 'ok',
    named_lists: 'ok',
    roaming_endpoints: 'ok',
    anycast_ha: 'ok',
  },
}

test('an array section counts its rows', () => {
  assert.deepEqual(inventoryRow('security_policies', LIVE), { value: 3, note: null })
  assert.deepEqual(inventoryRow('threat_feeds', LIVE), { value: 30, note: null })
  assert.deepEqual(inventoryRow('named_lists', LIVE), { value: 11, note: null })
})

test('roaming endpoints use their own total, not an array length', () => {
  // The section is an OBJECT. A generic reader would call Array.isArray on it,
  // get false, and print a dash or a zero for nine real endpoints.
  assert.deepEqual(inventoryRow('roaming_endpoints', LIVE), { value: 9, note: 'status unknown' })
})

test('every endpoint reporting unknown is said out loud, not shown as nine healthy ones', () => {
  // The live case. A bare 9 sitting beside "30 threat feeds" reads as coverage.
  const { note } = inventoryRow('roaming_endpoints', LIVE)
  assert.equal(note, 'status unknown')

  // A mixed breakdown is a real measurement and gets no disclaimer.
  const mixed = { ...LIVE, roaming_endpoints: { total: 9, by_status: { unknown: 4, online: 5 } } }
  assert.deepEqual(inventoryRow('roaming_endpoints', mixed), { value: 9, note: null })

  // So is an all-known one.
  const known = { ...LIVE, roaming_endpoints: { total: 5, by_status: { online: 5 } } }
  assert.deepEqual(inventoryRow('roaming_endpoints', known), { value: 5, note: null })
})

test('empty-and-ok is a real zero and says why, which is not what unavailable looks like', () => {
  // This tenant genuinely has no anycast members. That answer and a failed read
  // must not render the same, which is the oldest rule in this codebase.
  assert.deepEqual(inventoryRow('anycast_ha', LIVE), { value: 0, note: 'none configured' })

  const dead = { ...LIVE, availability: { ...LIVE.availability, anycast_ha: 'error' } }
  assert.deepEqual(inventoryRow('anycast_ha', dead), { value: null, note: 'unavailable' })
})

test('one dead section leaves every other section real', () => {
  const partial = {
    ...LIVE,
    threat_feeds: [],
    availability: { ...LIVE.availability, threat_feeds: 'error' },
  }
  assert.deepEqual(inventoryRow('threat_feeds', partial), { value: null, note: 'unavailable' })
  assert.deepEqual(inventoryRow('named_lists', partial), { value: 11, note: null }, 'the neighbours are untouched')
  assert.deepEqual(inventoryRow('roaming_endpoints', partial), { value: 9, note: 'status unknown' })
})

test('availability error wins even when the section still carries rows', () => {
  // The Go side returns an empty list alongside availability:"error", but a
  // future change that returned stale rows must not resurrect them as fact.
  const stale = {
    ...LIVE,
    availability: { ...LIVE.availability, security_policies: 'error' },
  }
  assert.deepEqual(inventoryRow('security_policies', stale), { value: null, note: 'unavailable' })
})

test('a section of the wrong shape is unavailable, never zero', () => {
  assert.deepEqual(inventoryRow('named_lists', { named_lists: null, availability: {} }), { value: null, note: 'unavailable' })
  assert.deepEqual(inventoryRow('named_lists', {}), { value: null, note: 'unavailable' })
  assert.deepEqual(inventoryRow('named_lists', null), { value: null, note: 'unavailable' })
  assert.deepEqual(inventoryRow('roaming_endpoints', { roaming_endpoints: {} }), { value: null, note: 'unavailable' })
  assert.deepEqual(
    inventoryRow('roaming_endpoints', { roaming_endpoints: { total: 'nine' } }),
    { value: null, note: 'unavailable' },
    'a string is not a total',
  )
})
