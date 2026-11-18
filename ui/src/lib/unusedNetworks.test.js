// Run with: npm test  (node --test, no test framework dependency)
//
// "Networks nobody uses": an IPv4 network of 4 addresses or more (a /30 or
// larger) whose only used addresses are the network and broadcast address.
// Measured on the live tenant 2026-11-17: /31 rows report used 0 or 2 of 2,
// /32 rows used 0 or 1 of 1, and every IPv6 row reports used 0 of total 0, so
// none of those can be judged by this rule and each says "not checked" (null).
import assert from 'node:assert/strict'
import test from 'node:test'
import { isUnused } from './unusedNetworks.js'

const row = (addr, cidr, used, total) => ({ addr, cidr, used, total })

test('IPv4 /24 and /30 with only network + broadcast are unused', () => {
  assert.equal(isUnused(row('10.0.0.0', 24, 2, 256)), true)
  assert.equal(isUnused(row('10.0.0.4', 30, 2, 4)), true)
})

test('an IPv4 network with any other address in use is not unused', () => {
  assert.equal(isUnused(row('10.0.0.0', 24, 3, 256)), false)
  assert.equal(isUnused(row('10.0.0.4', 30, 4, 4)), false)
})

test('/31, /32, IPv6 and unmeasured rows are not checked', () => {
  assert.equal(isUnused(row('10.1.2.4', 31, 2, 2)), null)
  assert.equal(isUnused(row('10.1.2.4', 31, 0, 2)), null)
  assert.equal(isUnused(row('10.1.2.9', 32, 0, 1)), null)
  assert.equal(isUnused(row('2400:4800:80a0::', 44, 0, 0)), null)
  assert.equal(isUnused(row('2400:4800:80a0::', 44, 2, 0)), null)
  assert.equal(isUnused(row('10.0.0.0', 24, null, null)), null)
})
