// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { ownedServices, shouldHidePanel } from './services.js'

// These tests exist for one reason: this is the only code in the app that
// REMOVES a panel from the page. Everywhere else a broken feed still leaves a
// card on screen saying it is broken; here a wrong answer makes the panel
// disappear entirely, and the operator has no way to tell "you don't own this"
// from "we couldn't ask". So the only state that may hide anything is an
// inventory read that authoritatively succeeded — availability "ok" AND a
// non-null service_types list. Everything else fails open.
//
// The wire contract (go/internal/dashboard/hub.go, FetchServiceInventory):
//   ok      — service_types is a complete list; [] means "genuinely owns none"
//   error   — the read failed; service_types is null, never []
//   partial — the read hit the 500-row limit, so an absent type is
//             indistinguishable from a truncated one

const OK = { availability: 'ok', service_types: ['dfp', 'dhcp', 'discovery', 'dns', 'ntp', 'orpheus'] }

test('an ok read with a complete list is authoritative', () => {
  const state = ownedServices(OK)
  assert.equal(state.unavailable, false)
  assert.equal(state.owned instanceof Set, true)
  assert.deepEqual([...state.owned].sort(), ['dfp', 'dhcp', 'discovery', 'dns', 'ntp', 'orpheus'])
})

test('a panel whose service type is absent from an ok list is hidden', () => {
  // 'ndns' is not in OK.service_types, and the list is complete, so this is
  // the one case where absence is a measurement.
  assert.equal(shouldHidePanel(ownedServices(OK), ['ndns']), true)
})

test('a panel is shown when ANY of its service types is owned', () => {
  // The DNS panels take dns|ndns: one deployed DNS service of either flavour
  // is enough for the panel to have something to show.
  assert.equal(shouldHidePanel(ownedServices(OK), ['dns', 'ndns']), false)
  assert.equal(shouldHidePanel(ownedServices(OK), ['dhcp', 'ndhcp']), false)
  assert.equal(shouldHidePanel(ownedServices(OK), ['dfp', 'orpheus']), false)
})

test('an authoritatively empty tenant hides its mapped panels', () => {
  // [] is not null: the read succeeded and this tenant deploys no services.
  const state = ownedServices({ availability: 'ok', service_types: [] })
  assert.equal(state.unavailable, false)
  assert.equal(state.owned.size, 0)
  assert.equal(shouldHidePanel(state, ['dns', 'ndns']), true)
})

test('a failed read hides NOTHING — a dead feed must not read as "you don\'t own this"', () => {
  const state = ownedServices({
    availability: 'error',
    service_types: null,
    reason: 'service inventory feed unavailable',
  })
  assert.equal(state.owned, null, 'unknown ownership must be null, never an empty Set')
  assert.equal(state.unavailable, true)
  assert.equal(shouldHidePanel(state, ['ndns']), false)
  assert.equal(shouldHidePanel(state, ['dns', 'ndns']), false)
})

test('a truncated read hides NOTHING, even for a type it did not list', () => {
  // partial carries real types — they were seen — but the SET is not
  // authoritative, so an absent type may simply have been cut off at row 500.
  const state = ownedServices({ availability: 'partial', service_types: ['dns'], reason: 'inventory truncated' })
  assert.equal(state.unavailable, true)
  assert.equal(state.owned, null, 'a truncated list must not be treated as the owned set')
  assert.equal(shouldHidePanel(state, ['ndhcp']), false)
})

test('service_types null with availability ok is still unknown, not "owns nothing"', () => {
  // Belt and braces against a future server bug: null is the wire's word for
  // "unknown" regardless of what availability says next to it.
  const state = ownedServices({ availability: 'ok', service_types: null })
  assert.equal(state.owned, null)
  assert.equal(state.unavailable, true)
  assert.equal(shouldHidePanel(state, ['ndns']), false)
})

test('a read still in flight, or one that threw, hides nothing', () => {
  assert.equal(ownedServices(null).owned, null)
  assert.equal(ownedServices(undefined).unavailable, true)
  assert.equal(shouldHidePanel(ownedServices(null), ['ndns']), false)
  assert.equal(shouldHidePanel(ownedServices(undefined), ['ndns']), false)
})

test('a garbage payload hides nothing', () => {
  // A 200 that is not the contract at all (an HTML error page parsed as JSON,
  // a proxy's own body) must not be read as an empty owned set.
  assert.equal(shouldHidePanel(ownedServices({}), ['ndns']), false)
  assert.equal(shouldHidePanel(ownedServices({ availability: 'ok', service_types: 'dns' }), ['ndns']), false)
  assert.equal(shouldHidePanel(ownedServices([]), ['ndns']), false)
})

test('a panel that declares no service types is never hidden', () => {
  // An empty required-list means "nothing to check" — hiding on it would hide
  // every unmapped panel the moment a wrapper was added without a map entry.
  assert.equal(shouldHidePanel(ownedServices(OK), []), false)
  assert.equal(shouldHidePanel(ownedServices(OK), undefined), false)
})
