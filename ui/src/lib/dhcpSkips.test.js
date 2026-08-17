import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dhcpSkips } from './dhcpSkips.js'

test('a result with no skips renders nothing', () => {
  assert.deepEqual(dhcpSkips(undefined), [])
  assert.deepEqual(dhcpSkips({}), [])
  assert.deepEqual(dhcpSkips({ dhcp_ranges_skipped: [] }), [])
  // Not a list — an older or malformed payload must not throw.
  assert.deepEqual(dhcpSkips({ dhcp_ranges_skipped: 'nope' }), [])
})

test('a skipped range is rendered with its subnet, range and reason', () => {
  const rows = dhcpSkips({
    dhcp_ranges_skipped: [{
      name: 'hq-lan-dhcp', subnet: '10.20.30.0/25',
      start: '10.20.30.10', end: '10.20.30.250',
      reason: 'offsets 10-250 fall outside subnet 10.20.30.0/25',
    }],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'hq-lan-dhcp')
  assert.equal(rows[0].subnet, '10.20.30.0/25')
  assert.equal(rows[0].range, '10.20.30.10–10.20.30.250')
  assert.match(rows[0].reason, /fall outside subnet/)
})

test('a skip with no computable addresses shows no range, not an empty one', () => {
  const [row] = dhcpSkips({
    dhcp_ranges_skipped: [{
      name: 'hq-lan-dhcp', subnet: '2001:db8::/64', start: '', end: '',
      reason: 'subnet 2001:db8::/64 is not IPv4',
    }],
  })
  assert.equal(row.range, '')
  assert.match(row.reason, /not IPv4/)
})

test('a nameless row is kept — a skip nobody can name is still a skip', () => {
  const rows = dhcpSkips({ dhcp_ranges_skipped: [{ reason: 'something' }, null, { name: 'x-dhcp' }] })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'DHCP range')
  assert.equal(rows[1].name, 'x-dhcp')
})

test('a row with no reason still says so rather than rendering blank', () => {
  const [row] = dhcpSkips({ dhcp_ranges_skipped: [{ name: 'x-dhcp' }] })
  assert.equal(row.reason, 'no reason given')
})

test('keys are unique so repeated skips on one subnet all render', () => {
  const rows = dhcpSkips({
    dhcp_ranges_skipped: [{ name: 'x-dhcp' }, { name: 'x-dhcp' }],
  })
  assert.equal(new Set(rows.map((r) => r.key)).size, 2)
})
