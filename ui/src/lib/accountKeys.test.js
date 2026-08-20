// Run with: npm test  (node --test, no test framework dependency)
//
// The name match behind the greyed-out rows in the CSP account picker, and the
// cases where it must NOT claim anything. Read lib/accountKeys.js first: the
// link between a CSP account and a saved key is the label and nothing stronger,
// which is exactly why the answer only dims a row and never blocks one.

import assert from 'node:assert/strict'
import test from 'node:test'
import { accountHasKey, keyedAccountNames } from './accountKeys.js'

// The live tenant on 2026-08-20: eight reachable CSP accounts, two saved keys.
const TENANTS = [
  { id: 'adda5c7871d5', label: 'Infoblox SE AMS' },
  { id: 'b84022133fb7', label: 'Infoblox Sales' },
]
const keyed = keyedAccountNames(TENANTS)

test('an account whose name matches a saved tenant is keyed', () => {
  assert.equal(accountHasKey({ id: 'identity/accounts/211e', name: 'Infoblox Sales' }, keyed), true)
  assert.equal(accountHasKey({ id: 'identity/accounts/8782', name: 'Infoblox SE AMS' }, keyed), true)
})

test('the other six live accounts are correctly reported as having no key', () => {
  for (const name of [
    'DELTA AIRLINES',
    'Here Holding Corporation',
    'Holland & Knight LLP',
    'Infoblox ULDP EA',
    'PM Demo',
    'PRESIDIO NETWORKED SOLUTIONS LLC',
  ]) {
    assert.equal(accountHasKey({ name }, keyed), false, `${name} should read as no key saved`)
  }
})

test('case and stray whitespace do not create a false "no key"', () => {
  // A tenant labelled by hand is one typo away from a name that matches
  // nothing, and dimming a row the operator does have a key for is the failure
  // mode that matters here.
  assert.equal(accountHasKey({ name: 'infoblox sales' }, keyed), true)
  assert.equal(accountHasKey({ name: '  Infoblox Sales  ' }, keyed), true)
  const padded = keyedAccountNames([{ label: '  Infoblox Sales  ' }])
  assert.equal(accountHasKey({ name: 'Infoblox Sales' }, padded), true)
})

test('a near miss is still a miss, and is not smoothed over', () => {
  // No fuzzy matching on purpose. "Infoblox Sales EU" is a different account and
  // guessing it shares a key would be the same class of invention this codebase
  // keeps removing.
  assert.equal(accountHasKey({ name: 'Infoblox Sales EU' }, keyed), false)
  assert.equal(accountHasKey({ name: 'Infoblox' }, keyed), false)
})

test('an account with no usable name is left alone rather than accused', () => {
  // "Cannot tell" must not render as "no key". The honest default for an
  // unmatchable row is to show it normally.
  assert.equal(accountHasKey({ name: '' }, keyed), true)
  assert.equal(accountHasKey({ name: '   ' }, keyed), true)
  assert.equal(accountHasKey({}, keyed), true)
  assert.equal(accountHasKey(undefined, keyed), true)
})

test('no saved tenants means nothing is claimed to be keyed', () => {
  const none = keyedAccountNames([])
  assert.equal(accountHasKey({ name: 'Infoblox Sales' }, none), false)
  assert.equal(keyedAccountNames(undefined).size, 0)
  assert.equal(keyedAccountNames(null).size, 0)
})

test('a tenant with no label contributes nothing instead of an empty match', () => {
  // Without the guard, a blank label would put '' in the set, and every
  // unnamed account would then "match" it.
  const withBlank = keyedAccountNames([{ id: 'x' }, { id: 'y', label: '' }, { id: 'z', label: 'Real One' }])
  assert.deepEqual([...withBlank], ['real one'])
})
