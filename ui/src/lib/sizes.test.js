import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressCount, usableCount, prefixForDevices, withSize, sizeLine, sizeWords } from './sizes.js'
import { sizeWords as reexported } from './spaceOptions.js'

test('addressCount is the total for a prefix, IPv4 by default', () => {
  assert.equal(addressCount(24), 256)
  assert.equal(addressCount('29'), 8)
  assert.equal(addressCount(32), 1)
  assert.equal(addressCount(0), null)
  assert.equal(addressCount(33), null)
  assert.equal(addressCount('x'), null)
})

test('addressCount counts IPv6 with BigInt', () => {
  assert.equal(addressCount(64, 6), 2n ** 64n)
  assert.equal(addressCount(128, 6), 1n)
  assert.equal(addressCount(129, 6), null)
})

test('usableCount takes off the network and broadcast addresses', () => {
  assert.equal(usableCount(24), 254)
  assert.equal(usableCount(30), 2)
  assert.equal(usableCount(31), 2)
  assert.equal(usableCount(32), 1)
  assert.equal(usableCount(40), null)
})

test('prefixForDevices picks the smallest network with room for that many', () => {
  assert.equal(prefixForDevices(180), 24)
  assert.equal(prefixForDevices(254), 24)
  assert.equal(prefixForDevices(255), 23)
  // Device counts never pick /31 or /32: the smallest is /30, with 2 usable.
  assert.equal(prefixForDevices(1), 30)
  assert.equal(prefixForDevices(2), 30)
  assert.equal(prefixForDevices(3), 29)
  assert.equal(prefixForDevices(6), 29)
  assert.equal(prefixForDevices(7), 28)
  assert.equal(prefixForDevices('100'), 25)
  assert.equal(prefixForDevices(0), null)
  assert.equal(prefixForDevices(-4), null)
  assert.equal(prefixForDevices(2.5), null)
  assert.equal(prefixForDevices(''), null)
  assert.equal(prefixForDevices(2 ** 32), null)
})

test('sizeWords counts IPv6 prefixes too', () => {
  assert.equal(sizeWords(64, 6), '18,446,744,073,709,551,616 addresses')
  assert.equal(sizeWords(128, 6), '1 address')
  assert.equal(sizeWords(129, 6), '')
})

test('withSize adds the address count to a network', () => {
  assert.equal(withSize('10.0.0.0/24'), '10.0.0.0/24 (256 addresses)')
  assert.equal(withSize('10.0.0.5/32'), '10.0.0.5/32 (1 address)')
  assert.equal(withSize('10.0.0.0/16'), '10.0.0.0/16 (65,536 addresses)')
  assert.equal(withSize('2001:db8::/120'), '2001:db8::/120 (256 addresses)')
  assert.equal(withSize('2001:db8::/64'), '2001:db8::/64 (18,446,744,073,709,551,616 addresses)')
  assert.equal(withSize('10.0.0.0'), '10.0.0.0')
  assert.equal(withSize('—'), '—')
  assert.equal(withSize(''), '')
  assert.equal(withSize(null), '')
})

test('sizeLine says total and usable in plain words', () => {
  assert.equal(sizeLine(24), '/24: 256 addresses, 254 usable by devices')
  assert.equal(sizeLine(32), '/32: 1 address, 1 usable by devices')
  assert.equal(sizeLine(''), '')
})

test('sizeWords moved here and is still exported from spaceOptions', () => {
  assert.equal(sizeWords(24), '256 addresses')
  assert.equal(sizeWords(32), '1 address')
  assert.equal(sizeWords(0), '')
  assert.equal(reexported, sizeWords)
})
