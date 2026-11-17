import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkedWords } from './checkedWords.js'

const MOCK = {
  checked: { spaces: 3, networks: 40, ranges: 14, reservations: 200, hosts: 12, age_seconds: 2 },
  skipped: [{ candidate: '10.16.8.0/24', reason: 'a DHCP range in corp-amer already uses 10.16.8.10 to 10.16.8.200' }],
}

test('the approved mock, word for word', () => {
  const w = checkedWords(MOCK)
  assert.equal(w.checked, 'Checked against: networks in 3 IP spaces, 14 DHCP ranges, 212 reservations and hosts.')
  assert.deepEqual(w.skips, ['Skipped 10.16.8.0/24 because a DHCP range in corp-amer already uses 10.16.8.10 to 10.16.8.200.'])
  assert.equal(w.more, '')
  assert.equal(w.age, '')
})

test('no skips: just the checked line', () => {
  const w = checkedWords({ checked: MOCK.checked, skipped: [] })
  assert.deepEqual(w.skips, [])
  assert.equal(w.more, '')
})

test('counts use thousands separators, and one is singular', () => {
  const w = checkedWords({ checked: { spaces: 1, networks: 9, ranges: 1, reservations: 1200, hosts: 34 } })
  assert.equal(w.checked, 'Checked against: networks in 1 IP space, 1 DHCP range, 1,234 reservations and hosts.')
  const one = checkedWords({ checked: { spaces: 2, networks: 3, ranges: 1234, reservations: 1, hosts: 0 } })
  assert.equal(one.checked, 'Checked against: networks in 2 IP spaces, 1,234 DHCP ranges, 1 reservation or host.')
})

test('an address-only check leaves networks out', () => {
  const w = checkedWords({ checked: { spaces: 4, networks: 0, ranges: 2, reservations: 3, hosts: 4 } })
  assert.equal(w.checked, 'Checked against: 2 DHCP ranges, 7 reservations and hosts.')
})

test('a long skip list shows the first 3 and says how many more', () => {
  const skipped = Array.from({ length: 7 }, (_, i) => ({ candidate: `10.0.${i}.0/24`, reason: 'a subnet in lab already uses it' }))
  const w = checkedWords({ checked: MOCK.checked, skipped })
  assert.equal(w.skips.length, 3)
  assert.equal(w.skips[2], 'Skipped 10.0.2.0/24 because a subnet in lab already uses it.')
  assert.equal(w.more, 'And 4 more.')
})

test('site and block results use skipped_picks, because skipped is a yes/no there', () => {
  const w = checkedWords({ checked: MOCK.checked, skipped: false, skipped_picks: MOCK.skipped })
  assert.equal(w.skips.length, 1)
})

test('data from the 2-minute cache says how old it is', () => {
  assert.equal(checkedWords({ checked: { ...MOCK.checked, age_seconds: 40 } }).age, 'Checked 40 seconds ago.')
  assert.equal(checkedWords({ checked: { ...MOCK.checked, age_seconds: 1 } }).age, '')
  assert.equal(checkedWords({ checked: { ...MOCK.checked, age_seconds: 130 } }).age, 'Checked 2 minutes ago.')
  assert.equal(checkedWords({ checked: { ...MOCK.checked, age_seconds: 60 } }).age, 'Checked 60 seconds ago.')
  assert.equal(checkedWords({ checked: { spaces: 1, networks: 1, ranges: 0, reservations: 0, hosts: 0 } }).age, '')
})

test('nothing to say: no checked field, or the check failed', () => {
  assert.equal(checkedWords(null), null)
  assert.equal(checkedWords({ ok: true }), null)
  assert.equal(checkedWords({ check_failed: true, checked: MOCK.checked }), null)
})

test('a reason that already ends in a full stop is not given two', () => {
  const w = checkedWords({ checked: MOCK.checked, skipped: [{ candidate: '10.1.1.5', reason: 'a host in lab already uses it.' }] })
  assert.equal(w.skips[0], 'Skipped 10.1.1.5 because a host in lab already uses it.')
})
