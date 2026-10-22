// Run with: npm test  (node --test, no test framework dependency)
//
// The Build a chart tab's logic. OPTIONS is the server's own /api/chart/options
// payload: a Go test (chart_builder_test.go) fails if this file drifts from it.

import assert from 'node:assert/strict'
import test from 'node:test'
import OPTIONS from '../../../tests/chart-options.json' with { type: 'json' }
import {
  DEFAULT_PICKS, choicesFor, settlePicks, chartKind, choiceName, sentence,
  chartData, fieldName, plainQuery, chartUrl, sampleTable,
} from './chartBuilder.js'

const picks = (count, split, window, over, top = 0) => ({ count, split, window, over, top })

test('the default picks are an allowed combination', () => {
  assert.deepEqual(settlePicks(OPTIONS, DEFAULT_PICKS), DEFAULT_PICKS)
})

test('each measure only offers its own cube\'s splits', () => {
  assert.deepEqual(choicesFor(OPTIONS, picks('dns')).split, ['device', 'qtype', 'none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('threats')).split, ['action', 'none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('qps')).split, ['none'])
})

test('by hour only with today, by day only with 7 or 30 days', () => {
  assert.deepEqual(choicesFor(OPTIONS, picks('dns', 'none', 'today')).over, ['hour'])
  assert.deepEqual(choicesFor(OPTIONS, picks('dns', 'none', '7d')).over, ['day'])
  assert.deepEqual(choicesFor(OPTIONS, picks('threats', 'action', '30d')).over, ['none', 'day'])
})

test('how many is offered only for a split with no over-time', () => {
  assert.deepEqual(choicesFor(OPTIONS, picks('dns', 'device', '7d', 'none')).top, [5, 10, 25])
  assert.deepEqual(choicesFor(OPTIONS, picks('threats', 'action', '7d', 'day')).top, [0])
  assert.deepEqual(choicesFor(OPTIONS, picks('dns', 'none', '7d', 'day')).top, [0])
})

test('a pick that stops fitting snaps to the first choice that does', () => {
  // Record type over 7 days, then the measure changes to security hits.
  assert.deepEqual(settlePicks(OPTIONS, picks('threats', 'qtype', '7d', 'none', 10)), picks('threats', 'action', '7d', 'none', 10))
  // By day, then the window changes to today.
  assert.deepEqual(settlePicks(OPTIONS, picks('dns', 'none', 'today', 'day')), picks('dns', 'none', 'today', 'hour'))
  // Top 10 devices, then over-time is chosen: the top N drops.
  assert.deepEqual(settlePicks(OPTIONS, picks('threats', 'action', '7d', 'day', 10)), picks('threats', 'action', '7d', 'day', 0))
  // Everything the settler returns is on the server's allow-list.
  for (const c of ['dns', 'threats', 'qps']) {
    for (const s of ['device', 'qtype', 'action', 'none']) {
      for (const w of ['today', '7d', '30d']) {
        for (const o of ['none', 'hour', 'day']) {
          const p = settlePicks(OPTIONS, picks(c, s, w, o, 10))
          assert.ok(OPTIONS.combos.some((x) => JSON.stringify(x) === JSON.stringify(p)), JSON.stringify(p))
        }
      }
    }
  }
})

test('the chart type is picked from the picks', () => {
  assert.equal(chartKind(picks('dns', 'none', 'today', 'hour')), 'line')
  assert.equal(chartKind(picks('qps', 'none', '7d', 'day')), 'line')
  assert.equal(chartKind(picks('threats', 'action', '30d', 'day')), 'stacked')
  assert.equal(chartKind(picks('dns', 'device', '7d', 'none', 10)), 'bars')
  assert.equal(chartKind(picks('threats', 'action', '7d', 'none', 5)), 'bars')
  assert.equal(chartKind(picks('dns', 'qtype', '7d', 'none', 10)), 'donut')
})

test('the sentence says what the chart shows, in plain words', () => {
  const s = (p) => sentence(OPTIONS, p, false)
  assert.equal(s(picks('dns', 'device', '7d', 'none', 10)), 'Top 10 devices by DNS queries, last 7 days')
  assert.equal(s(picks('dns', 'qtype', '30d', 'none', 5)), 'Top 5 record types by DNS queries, last 30 days')
  assert.equal(s(picks('dns', 'none', 'today', 'hour')), 'DNS queries by hour, today')
  assert.equal(s(picks('threats', 'action', '30d', 'day')), 'Security hits by day, blocked vs allowed, last 30 days')
  assert.equal(s(picks('threats', 'action', '7d', 'none', 5)), 'Security hits, blocked vs allowed, last 7 days')
  assert.equal(s(picks('qps', 'none', '7d', 'day')), 'DNS queries per second by day, last 7 days')
})

test('with cube names on, the sentence uses the real names', () => {
  assert.equal(
    sentence(OPTIONS, picks('dns', 'device', '7d', 'none', 10), true),
    'NetworkNstarDnsActivity.total_query_count by NetworkNstarDnsActivity.device_name, NetworkNstarDnsActivity.device_ip, last 7 days, limit 10',
  )
  assert.equal(
    sentence(OPTIONS, picks('qps', 'none', 'today', 'hour'), true),
    'HostMetrics.avg_value by HostMetrics.timestamp.hour, today',
  )
})

test('menu names swap with the switch', () => {
  assert.equal(choiceName(OPTIONS, 'count', 'dns', false), 'DNS queries')
  assert.equal(choiceName(OPTIONS, 'count', 'dns', true), 'NetworkNstarDnsActivity.total_query_count')
  assert.equal(choiceName(OPTIONS, 'split', 'action', false), 'What happened')
  assert.equal(choiceName(OPTIONS, 'split', 'action', true), 'PortunusAggThreat_ch.action')
  assert.equal(choiceName(OPTIONS, 'window', '7d', true), 'last 7 days')
  assert.equal(choiceName(OPTIONS, 'over', 'hour', true), 'hour')
  assert.equal(choiceName(OPTIONS, 'top', 10, false), 'Top 10')
  assert.equal(choiceName(OPTIONS, 'top', 10, true), 'limit 10')
})

test('field names swap with the switch, time suffixes included', () => {
  assert.equal(fieldName(OPTIONS, 'NetworkNstarDnsActivity.device_ip', false), 'Device address')
  assert.equal(fieldName(OPTIONS, 'NetworkNstarDnsActivity.device_ip', true), 'NetworkNstarDnsActivity.device_ip')
  assert.equal(fieldName(OPTIONS, 'PortunusAggThreat_ch.timestamp.day', false), 'Time')
  assert.equal(fieldName(OPTIONS, 'PortunusAggThreat_ch.timestamp.day', true), 'PortunusAggThreat_ch.timestamp.day')
})

test('top devices become bars named by device, counts as numbers', () => {
  const rows = [
    { 'NetworkNstarDnsActivity.device_name': 'ws-1', 'NetworkNstarDnsActivity.device_ip': '10.0.0.1', 'NetworkNstarDnsActivity.total_query_count': '48211' },
    { 'NetworkNstarDnsActivity.device_name': '', 'NetworkNstarDnsActivity.device_ip': '10.0.0.2', 'NetworkNstarDnsActivity.total_query_count': '9' },
  ]
  assert.deepEqual(chartData(OPTIONS, picks('dns', 'device', '7d', 'none', 10), rows, false), [
    { name: 'ws-1', value: 48211 },
    { name: '10.0.0.2', value: 9 },
  ])
})

test('blocked and allowed read as words, or as the raw values with cube names on', () => {
  // The tenant sends Block / Allow, capitalised (measured live 2026-10-21).
  const rows = [
    { 'PortunusAggThreat_ch.action': 'Block', 'PortunusAggThreat_ch.requests': '41' },
    { 'PortunusAggThreat_ch.action': 'Allow', 'PortunusAggThreat_ch.requests': '3' },
    { 'PortunusAggThreat_ch.action': 'block', 'PortunusAggThreat_ch.requests': '1' },
  ]
  const p = picks('threats', 'action', '7d', 'none', 5)
  assert.deepEqual(chartData(OPTIONS, p, rows, false).map((d) => d.name), ['Blocked', 'Allowed', 'Blocked'])
  assert.deepEqual(chartData(OPTIONS, p, rows, true).map((d) => d.name), ['Block', 'Allow', 'block'])
})

test('two devices with one name are told apart by address', () => {
  const rows = [
    { 'NetworkNstarDnsActivity.device_name': 'demo-www', 'NetworkNstarDnsActivity.device_ip': '172.16.138.201', 'NetworkNstarDnsActivity.total_query_count': '8513' },
    { 'NetworkNstarDnsActivity.device_name': 'www-east', 'NetworkNstarDnsActivity.device_ip': '172.16.0.67', 'NetworkNstarDnsActivity.total_query_count': '1017' },
    { 'NetworkNstarDnsActivity.device_name': 'demo-www', 'NetworkNstarDnsActivity.device_ip': '172.16.136.201', 'NetworkNstarDnsActivity.total_query_count': '225' },
  ]
  assert.deepEqual(chartData(OPTIONS, picks('dns', 'device', '7d', 'none', 10), rows, false).map((d) => d.name), [
    'demo-www (172.16.138.201)', 'www-east', 'demo-www (172.16.136.201)',
  ])
})

test('over time becomes a line in time order, labelled the way people say it', () => {
  const rows = [
    { 'NetworkNstarDnsActivity.timestamp.hour': '2026-10-21T14:00:00.000', 'NetworkNstarDnsActivity.total_query_count': '20' },
    { 'NetworkNstarDnsActivity.timestamp.hour': '2026-10-21T13:00:00.000', 'NetworkNstarDnsActivity.total_query_count': '10' },
  ]
  assert.deepEqual(chartData(OPTIONS, picks('dns', 'none', 'today', 'hour'), rows, false), [
    { label: '13:00', value: 10 },
    { label: '14:00', value: 20 },
  ])
  const days = [{ 'HostMetrics.timestamp.day': '2026-10-20T00:00:00.000', 'HostMetrics.avg_value': '346.1' }]
  assert.deepEqual(chartData(OPTIONS, picks('qps', 'none', '7d', 'day'), days, false), [{ label: 'Oct 20', value: 346.1 }])
})

test('security by day stacks blocked over everything else, nothing dropped', () => {
  const rows = [
    { 'PortunusAggThreat_ch.timestamp.day': '2026-10-20T00:00:00.000', 'PortunusAggThreat_ch.action': 'Block', 'PortunusAggThreat_ch.requests': '41' },
    { 'PortunusAggThreat_ch.timestamp.day': '2026-10-20T00:00:00.000', 'PortunusAggThreat_ch.action': 'Allow', 'PortunusAggThreat_ch.requests': '3' },
    { 'PortunusAggThreat_ch.timestamp.day': '2026-10-19T00:00:00.000', 'PortunusAggThreat_ch.action': 'log', 'PortunusAggThreat_ch.requests': '5' },
  ]
  assert.deepEqual(chartData(OPTIONS, picks('threats', 'action', '30d', 'day'), rows, false), [
    { day: 'Oct 19', blocked: 0, allowed: 5 },
    { day: 'Oct 20', blocked: 41, allowed: 3 },
  ])
})

test('record types become donut slices', () => {
  const rows = [
    { 'NetworkNstarDnsActivity.query_type': 'A', 'NetworkNstarDnsActivity.total_query_count': '90' },
    { 'NetworkNstarDnsActivity.query_type': 'AAAA', 'NetworkNstarDnsActivity.total_query_count': '10' },
  ]
  assert.deepEqual(chartData(OPTIONS, picks('dns', 'qtype', '7d', 'none', 10), rows, false), [
    { name: 'A', value: 90 },
    { name: 'AAAA', value: 10 },
  ])
})

test('the plain query is the real query with every name made plain', () => {
  const q = {
    measures: ['HostMetrics.avg_value'],
    filters: [{ member: 'HostMetrics.metric_name', operator: 'equals', values: ['dns_qps_iq'] }],
    timeDimensions: [{ dimension: 'HostMetrics.timestamp', dateRange: 'today', granularity: 'hour' }],
  }
  assert.deepEqual(plainQuery(OPTIONS, q), {
    measures: ['Queries per second'],
    filters: [{ member: 'Metric', operator: 'equals', values: ['DNS queries per second'] }],
    timeDimensions: [{ dimension: 'Time', dateRange: 'today', granularity: 'hour' }],
  })
  const top = { measures: ['NetworkNstarDnsActivity.total_query_count'], order: { 'NetworkNstarDnsActivity.total_query_count': 'desc' }, limit: 10 }
  assert.deepEqual(plainQuery(OPTIONS, top), { measures: ['DNS queries'], order: { 'DNS queries': 'desc' }, limit: 10 })
})

test('the request URL carries the picks, and top only when it applies', () => {
  assert.equal(chartUrl(picks('dns', 'device', '7d', 'none', 10)), '/api/chart?count=dns&split=device&window=7d&over=none&top=10')
  assert.equal(chartUrl(picks('dns', 'none', 'today', 'hour')), '/api/chart?count=dns&split=none&window=today&over=hour')
})

test('the sample table drops the duplicate time column and names values plainly', () => {
  // Cube sends the timestamp twice when sliced by time, bare and with the slice.
  const rows = [
    { 'PortunusAggThreat_ch.action': 'Allow', 'PortunusAggThreat_ch.requests': '80309', 'PortunusAggThreat_ch.timestamp': '2026-09-22T00:00:00.000', 'PortunusAggThreat_ch.timestamp.day': '2026-09-22T00:00:00.000' },
    { 'PortunusAggThreat_ch.action': 'Block', 'PortunusAggThreat_ch.requests': '572222', 'PortunusAggThreat_ch.timestamp': '2026-09-22T00:00:00.000', 'PortunusAggThreat_ch.timestamp.day': '2026-09-22T00:00:00.000' },
  ]
  assert.deepEqual(sampleTable(OPTIONS, rows, false), {
    headers: ['What happened', 'Hits', 'Time'],
    rows: [['Allowed', '80309', '2026-09-22T00:00:00.000'], ['Blocked', '572222', '2026-09-22T00:00:00.000']],
  })
  assert.deepEqual(sampleTable(OPTIONS, rows, true).headers, ['PortunusAggThreat_ch.action', 'PortunusAggThreat_ch.requests', 'PortunusAggThreat_ch.timestamp.day'])
  assert.deepEqual(sampleTable(OPTIONS, rows, true).rows[0][0], 'Allow')
  assert.deepEqual(sampleTable(OPTIONS, [], false), { headers: [], rows: [] })
})
