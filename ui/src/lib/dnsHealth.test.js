// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { dnsHosts, fmtAnswerTime, fmtPerSecond, fmtShare, hasPerHost, healthMetric, hostLoadRows, hostMetricText, NO_READINGS, NOT_CHECKED, splitPerHost } from './dnsHealth.js'

const feed = (metrics, extra = {}) => ({ loading: false, error: null, data: { status: 'ok', metrics }, ...extra })

test('answer times are shown in milliseconds, tiny ones honestly', () => {
  assert.equal(fmtAnswerTime(0.06385), '64 ms')
  assert.equal(fmtAnswerTime(0.0045), '4.5 ms')
  assert.equal(fmtAnswerTime(0.00000019), 'under 0.1 ms')
})

test('shares and rates', () => {
  assert.equal(fmtShare(62.138), '62%')
  assert.equal(fmtShare(1.589), '1.6%')
  assert.equal(fmtShare(0.02), 'under 0.1%')
  // Between 99 and 100 a gap is never rounded away (99.5% uptime read "100%").
  assert.equal(fmtShare(99.5), '99.5%')
  assert.equal(fmtShare(99.97), '99.9%')
  assert.equal(fmtShare(100), '100%')
  assert.equal(fmtShare(98.6), '99%')
  assert.equal(fmtPerSecond(14.3165), '14 a second')
  assert.equal(fmtPerSecond(1.62), '1.6 a second')
})

test('an ok metric reads in its unit', () => {
  const f = feed({ answer_time: { status: 'ok', unit: 'seconds', value: 0.0638 } })
  assert.deepEqual(healthMetric(f, 'answer_time'), { state: 'ok', value: 0.0638, text: '64 ms' })
})

test('a failed metric, a failed feed or a missing key is not checked, never 0', () => {
  assert.equal(healthMetric(feed({ success: { status: 'error', unit: 'percent', value: null } }), 'success').text, NOT_CHECKED)
  assert.equal(healthMetric({ loading: false, error: 'boom', data: null }, 'success').text, NOT_CHECKED)
  assert.equal(healthMetric(feed({}), 'success').text, NOT_CHECKED)
})

test('a read with no readings says so', () => {
  assert.equal(healthMetric(feed({ answer_time_own: { status: 'empty', unit: 'seconds', value: null } }), 'answer_time_own').text, NO_READINGS)
})

test('loading before the first answer', () => {
  assert.equal(healthMetric({ loading: true, data: null }, 'success').state, 'loading')
})

test('per-host readings by id or name; null is no readings; failed is not checked', () => {
  const f = feed({ timeouts: { status: 'ok', unit: 'per_second', value: 2, hosts: [{ host: 'u1', host_name: 'ns1', value: 3.2 }, { host: 'u2', host_name: 'ns2', value: null }] } })
  assert.equal(hostMetricText(f, 'timeouts', ['u1']), '3.2 a second')
  assert.equal(hostMetricText(f, 'timeouts', ['x', 'ns1']), '3.2 a second')
  assert.equal(hostMetricText(f, 'timeouts', ['u2']), NO_READINGS)
  assert.equal(hostMetricText(feed({ timeouts: { status: 'error' } }), 'timeouts', ['u1']), NOT_CHECKED)
  assert.equal(hasPerHost(f, ['timeouts']), true)
  assert.equal(hasPerHost(feed({ timeouts: { status: 'ok', hosts: [] } }), ['timeouts']), false)
})

test('host load rows pair CPU and memory, keep a missing reading null, busiest first', () => {
  const rows = hostLoadRows([
    { host: 'a', host_name: 'ns-a', metric_name: 'host_cpu', avg_value: 12 },
    { host: 'a', host_name: 'ns-a', metric_name: 'host_memory', avg_value: null },
    { host: 'b', host_name: 'ns-b', metric_name: 'host_cpu', avg_value: 80 },
    { host: 'c', host_name: 'ns-c', metric_name: 'host_memory', avg_value: 40 },
  ])
  assert.deepEqual(rows.map((r) => r.host), ['b', 'a', 'c'])
  assert.deepEqual(rows[1], { host: 'a', host_name: 'ns-a', cpu: 12, memory: null })
  assert.equal(rows[2].cpu, null)
})

test('per-host or account-wide is decided per metric', () => {
  // Answer time comes per host, timeouts only for the whole account: only
  // answer time becomes a column, and timeouts keeps its account-wide reading.
  const f = feed({
    answer_time: { status: 'ok', unit: 'seconds', value: 0.05, hosts: [{ host: 'u1', host_name: 'ns1', value: 0.04 }] },
    timeouts: { status: 'ok', unit: 'per_second', value: 14.3, hosts: [] },
  })
  assert.deepEqual(splitPerHost(f, ['answer_time', 'timeouts']), { perHost: ['answer_time'], accountWide: ['timeouts'] })
  assert.equal(healthMetric(f, 'timeouts').text, '14 a second')
})

test('a host with DNS readings but no CPU or memory row is still listed', () => {
  const f = feed({
    answer_time: { status: 'ok', unit: 'seconds', value: 0.05, hosts: [{ host: 'dns-only', host_name: 'ns9', value: 0.04 }, { host: 'a', host_name: 'ns-a', value: 0.06 }] },
    timeouts: { status: 'ok', unit: 'per_second', value: 2, hosts: [{ host: 'dns-only', host_name: 'ns9', value: 1 }] },
  })
  const extra = dnsHosts(f, ['answer_time', 'timeouts'])
  assert.deepEqual(extra, [{ host: 'dns-only', host_name: 'ns9' }, { host: 'a', host_name: 'ns-a' }])
  const rows = hostLoadRows([{ host: 'a', host_name: 'ns-a', metric_name: 'host_cpu', avg_value: 12 }], extra)
  assert.deepEqual(rows.map((r) => r.host), ['a', 'dns-only'])
  assert.deepEqual(rows[1], { host: 'dns-only', host_name: 'ns9', cpu: null, memory: null })
  assert.equal(hostMetricText(f, 'answer_time', [rows[1].host, rows[1].host_name]), '40 ms')
})
