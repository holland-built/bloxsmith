import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DHCP_HA_NOTE, fmtCount, NO_READINGS, NOT_CHECKED, platformMetric, platformRows, uptimeHosts } from './valuePlatform.js'

const feed = (metrics, extra = {}) => ({ loading: false, error: null, data: { status: 'ok', window: 'last 30 days', metrics }, ...extra })

const live = {
  queries: { status: 'ok', value: 25431225.68867135, unit: 'queries' },
  cache_hit: { status: 'ok', value: 44.695256666666666, unit: 'percent' },
  uptime: { status: 'unavailable', value: null, unit: 'percent', hosts: [], reason: "Not available: Infoblox doesn't say what its DNS status number measures." },
  dhcp_assigned: { status: 'ok', value: 5744, unit: 'addresses' },
  roaming: { status: 'ok', value: 7, unit: 'devices' },
}

test('fmtCount writes big counts in words and small ones in full', () => {
  assert.equal(fmtCount(25431225.68), '25.4 million')
  assert.equal(fmtCount(5744), '5,744')
  assert.equal(fmtCount(7), '7')
  assert.equal(fmtCount(0), '0')
  assert.equal(fmtCount(2.5e9), '2.5 billion')
})

test('live numbers read as plain words', () => {
  const f = feed(live)
  assert.deepEqual(platformMetric(f, 'queries'), { state: 'ok', value: 25431225.68867135, text: '25.4 million' })
  assert.equal(platformMetric(f, 'cache_hit').text, '45%')
  assert.equal(platformMetric(f, 'dhcp_assigned').text, '5,744')
  assert.equal(platformMetric(f, 'roaming').text, '7')
})

test('a failed read says not checked, never 0', () => {
  const f = feed({ ...live, queries: { status: 'error', value: null, unit: 'queries' } })
  assert.deepEqual(platformMetric(f, 'queries'), { state: 'error', value: null, text: NOT_CHECKED })
  assert.equal(platformMetric(feed({}), 'roaming').text, NOT_CHECKED)
  assert.equal(platformMetric({ error: 'boom', data: { metrics: live } }, 'cache_hit').text, NOT_CHECKED)
})

test('ok with a null or non-numeric value is no readings, not 0', () => {
  for (const value of [null, 'n/a', '', false]) {
    const m = platformMetric(feed({ queries: { status: 'ok', value, unit: 'queries' } }), 'queries')
    assert.equal(m.text, NO_READINGS)
    assert.equal(m.value, null)
  }
})

test('an unknown unit is not guessed', () => {
  assert.equal(platformMetric(feed({ queries: { status: 'ok', value: 3, unit: 'furlongs' } }), 'queries').text, NOT_CHECKED)
})

test('unavailable shows the reason', () => {
  const m = platformMetric(feed(live), 'uptime')
  assert.equal(m.state, 'unavailable')
  assert.equal(m.text, "Not available: Infoblox doesn't say what its DNS status number measures.")
  assert.equal(platformMetric(feed({ roaming: { status: 'unavailable', reason: 'Not available on this tenant.' } }), 'roaming').text, 'Not available on this tenant.')
  assert.equal(platformMetric(feed({ roaming: { status: 'unavailable' } }), 'roaming').text, 'Not available on this tenant.')
})

test('loading before the first answer', () => {
  assert.equal(platformMetric({ loading: true }, 'queries').state, 'loading')
})

test('uptime hosts list each host, missing readings as no readings', () => {
  const f = feed({ uptime: { status: 'ok', value: 97.5, unit: 'percent', hosts: [
    { host: 'a', host_name: 'ns1', value: 100 },
    { host: 'b', host_name: '', value: null },
  ] } })
  assert.deepEqual(uptimeHosts(f), [{ name: 'ns1', text: '100%' }, { name: 'b', text: NO_READINGS }])
  assert.deepEqual(uptimeHosts(feed(live)), [])
})

test('rows come in order with the HA note on DHCP only', () => {
  const rows = platformRows(feed(live))
  assert.deepEqual(rows.map((r) => r.key), ['queries', 'cache_hit', 'uptime', 'dhcp_assigned', 'roaming'])
  assert.equal(rows[3].note, DHCP_HA_NOTE)
  assert.equal(rows.filter((r) => r.note).length, 1)
})
