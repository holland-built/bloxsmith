// Run with: npm test  (node --test, no test framework dependency)
//
// The Build a chart tab's logic. OPTIONS is the server's own /api/chart/options
// payload: a Go test (chart_builder_test.go) fails if this file drifts from it.

import assert from 'node:assert/strict'
import test from 'node:test'
import OPTIONS from '../../../tests/chart-options.json' with { type: 'json' }
import {
  DEFAULT_PICKS, choicesFor, settlePicks, chartKind, choiceName, sentence,
  chartData, fieldName, describePicks, chartUrl, sampleTable, shortLabel, chartLink, picksFromParams, toCsv, sideways, pickOne,
} from './chartBuilder.js'

const picks = (count, split, window, over, top = 0) => ({ count, split, window, over, top })

test('the default picks are an allowed combination', () => {
  assert.deepEqual(settlePicks(OPTIONS, DEFAULT_PICKS), DEFAULT_PICKS)
})

test('each measure only offers its own cube\'s splits', () => {
  assert.deepEqual(choicesFor(OPTIONS, picks('dns')).split, ['device', 'qtype', 'domain', 'rcode', 'none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('threats')).split, ['action', 'tclass', 'policy', 'severity', 'none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('qps')).split, ['none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('dhcp')).split, ['leaseop', 'none'])
})

test('by hour only with today or the last 24 hours, by day only with 7 or 30 days', () => {
  assert.deepEqual(choicesFor(OPTIONS, picks('dns', 'none', 'today')).over, ['hour', 'none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('dns', 'none', '24h')).over, ['hour', 'none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('dns', 'none', '7d')).over, ['day', 'none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('threats', 'action', '30d')).over, ['day', 'none'])
  // The security cube keeps one row a day, so it never slices by hour.
  assert.deepEqual(choicesFor(OPTIONS, picks('threats', 'action', 'today')).over, ['none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('dns', 'domain', '24h')).over, ['none'])
  assert.deepEqual(choicesFor(OPTIONS, picks('dhcp', 'none')).window, ['today', '24h', '7d', '30d'])
  // Nor a rolling 24 hours: day rows can't be cut at this time yesterday.
  assert.deepEqual(choicesFor(OPTIONS, picks('threats', 'action')).window, ['today', '7d', '30d'])
})

test('the new splits are top N only', () => {
  for (const [c, s] of [['dns', 'domain'], ['dns', 'rcode'], ['threats', 'tclass'], ['threats', 'policy'], ['threats', 'severity'], ['dhcp', 'leaseop']]) {
    for (const w of c === 'threats' ? ['today', '7d', '30d'] : ['today', '24h', '7d', '30d']) {
      assert.deepEqual(choicesFor(OPTIONS, picks(c, s, w)).over, ['none'], `${c}/${s}/${w}`)
    }
  }
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
  for (const c of ['dns', 'threats', 'qps', 'dhcp']) {
    for (const s of ['device', 'qtype', 'domain', 'rcode', 'action', 'tclass', 'policy', 'severity', 'leaseop', 'none']) {
      for (const w of ['today', '24h', '7d', '30d']) {
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
  assert.equal(s(picks('qps', 'none', '24h', 'hour')), 'DNS queries per second by hour, last 24 hours')
})

test('every top N sentence uses a real plural', () => {
  const s = (p) => sentence(OPTIONS, p, false)
  assert.equal(s(picks('dns', 'domain', '7d', 'none', 10)), 'Top 10 domains by DNS queries, last 7 days')
  assert.equal(s(picks('dns', 'rcode', '7d', 'none', 5)), 'Top 5 answers by DNS queries, last 7 days')
  assert.equal(s(picks('threats', 'tclass', '7d', 'none', 5)), 'Top 5 threat types by Security hits, last 7 days')
  assert.equal(s(picks('threats', 'policy', 'today', 'none', 5)), 'Top 5 policies by Security hits, today')
  assert.equal(s(picks('threats', 'severity', '30d', 'none', 10)), 'Top 10 severities by Security hits, last 30 days')
  assert.equal(s(picks('dhcp', 'leaseop', 'today', 'none', 5)), 'Top 5 kinds of change by DHCP lease changes, today')
  assert.equal(s(picks('dhcp', 'none', '30d', 'day')), 'DHCP lease changes by day, last 30 days')
  // Every allowed combination reads without "undefined" or a doubled "s".
  for (const c of OPTIONS.combos) {
    const text = s(c)
    assert.doesNotMatch(text, /undefined|null|policys|severitys|happeneds|changeds|answer codes|\bs\b/, text)
  }
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
  // Block and block are one outcome, so in plain words they are one bar.
  assert.deepEqual(chartData(OPTIONS, p, rows, false), [{ name: 'Blocked', value: 42 }, { name: 'Allowed', value: 3 }])
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

test('how the chart was made: one short labelled line per pick that applies', () => {
  const d = (p, cube = false) => describePicks(OPTIONS, p, cube)
  assert.deepEqual(d(picks('dns', 'device', '7d', 'none', 10)), [
    { label: 'Counted', text: 'DNS queries' },
    { label: 'Split by', text: 'Device' },
    { label: 'When', text: 'Last 7 days' },
    { label: 'Showing', text: 'Top 10, highest first' },
  ])
  assert.deepEqual(d(picks('qps', 'none', '24h', 'hour')), [
    { label: 'Counted', text: 'DNS queries per second' },
    { label: 'When', text: 'Last 24 hours' },
    { label: 'Over time', text: 'By hour' },
    { label: 'Only counting', text: 'rows where Metric is DNS queries per second' },
  ])
  assert.deepEqual(d(picks('threats', 'action', '30d', 'day')), [
    { label: 'Counted', text: 'Security hits' },
    { label: 'Split by', text: 'What happened' },
    { label: 'When', text: 'Last 30 days' },
    { label: 'Over time', text: 'By day' },
  ])
  assert.deepEqual(d(picks('dhcp', 'leaseop', 'today', 'none', 5)), [
    { label: 'Counted', text: 'DHCP lease changes' },
    { label: 'Split by', text: 'What changed' },
    { label: 'When', text: 'Today' },
    { label: 'Showing', text: 'Top 5, highest first' },
  ])
  // Every count, every allowed combination: Counted and When are always there.
  for (const c of OPTIONS.combos) {
    const labels = d(c).map((l) => l.label)
    assert.equal(labels[0], 'Counted')
    assert.ok(labels.includes('When'))
    assert.ok(d(c).every((l) => l.text && !/undefined/.test(l.text)), JSON.stringify(c))
  }
})

test('with cube names on, the lines use the real names', () => {
  assert.deepEqual(describePicks(OPTIONS, picks('qps', 'none', 'today', 'hour'), true), [
    { label: 'Counted', text: 'HostMetrics.avg_value' },
    { label: 'When', text: 'today' },
    { label: 'Over time', text: 'hour' },
    { label: 'Only counting', text: 'HostMetrics.metric_name equals dns_qps_iq' },
  ])
  assert.deepEqual(describePicks(OPTIONS, picks('dns', 'domain', '7d', 'none', 25), true), [
    { label: 'Counted', text: 'NetworkNstarDnsActivity.total_query_count' },
    { label: 'Split by', text: 'NetworkNstarDnsActivity.qname' },
    { label: 'When', text: 'last 7 days' },
    { label: 'Showing', text: 'limit 25, NetworkNstarDnsActivity.total_query_count desc' },
  ])
})

test('answer codes read as words, and an unknown code still shows', () => {
  const rows = [
    { 'NetworkNstarDnsActivity.rcode': '0', 'NetworkNstarDnsActivity.total_query_count': '102600000' },
    { 'NetworkNstarDnsActivity.rcode': 3, 'NetworkNstarDnsActivity.total_query_count': '55300000' },
    { 'NetworkNstarDnsActivity.rcode': '2', 'NetworkNstarDnsActivity.total_query_count': '2500000' },
    { 'NetworkNstarDnsActivity.rcode': '5', 'NetworkNstarDnsActivity.total_query_count': '12' },
  ]
  const p = picks('dns', 'rcode', '7d', 'none', 5)
  assert.deepEqual(chartData(OPTIONS, p, rows, false).map((d) => d.name), ['Answered', 'No such name', 'Server failed', 'Answer code 5'])
  assert.deepEqual(chartData(OPTIONS, p, rows, true).map((d) => d.name), ['0', '3', '2', '5'])
  assert.deepEqual(sampleTable(OPTIONS, rows, false).rows.map((r) => r[0]), ['Answered', 'No such name', 'Server failed', 'Answer code 5'])
})

test('a blank severity reads as Not graded and is kept, as one bar', () => {
  const rows = [
    { 'PortunusAggThreat_ch.severity': '', 'PortunusAggThreat_ch.requests': '2550000' },
    { 'PortunusAggThreat_ch.severity': null, 'PortunusAggThreat_ch.requests': '7' },
    { 'PortunusAggThreat_ch.severity': 'High', 'PortunusAggThreat_ch.requests': '370000' },
  ]
  const data = chartData(OPTIONS, picks('threats', 'severity', '7d', 'none', 5), rows, false)
  // Blank and missing both read as Not graded, so they are one bar, not two.
  assert.deepEqual(data, [
    { name: 'Not graded', value: 2550007 },
    { name: 'High', value: 370000 },
  ])
  assert.deepEqual(sampleTable(OPTIONS, rows, false).rows.map((r) => r[0]), ['Not graded', 'Not graded', 'High'])
  // A merged bar moves to where its total puts it, so highest first still holds.
  const mixed = [
    { 'PortunusAggThreat_ch.severity': 'High', 'PortunusAggThreat_ch.requests': '90' },
    { 'PortunusAggThreat_ch.severity': '', 'PortunusAggThreat_ch.requests': '80' },
    { 'PortunusAggThreat_ch.severity': 'Medium', 'PortunusAggThreat_ch.requests': '75' },
    { 'PortunusAggThreat_ch.severity': null, 'PortunusAggThreat_ch.requests': '70' },
  ]
  assert.deepEqual(chartData(OPTIONS, picks('threats', 'severity', '7d', 'none', 5), mixed, false).map((d) => d.name), ['Not graded', 'High', 'Medium'])
})

test('long bar labels are shortened in the middle, short ones kept', () => {
  assert.equal(shortLabel('www.facebook.com.'), 'www.facebook.com.')
  // recharts passes the tick index second; it must not shorten anything.
  assert.equal(shortLabel('baseline-ws-1', 0), 'baseline-ws-1')
  const long = 'e1234.dscb.akamaiedge.example-cdn.net.'
  const short = shortLabel(long)
  assert.ok(short.length <= 20, short)
  assert.ok(short.startsWith('e1234') && short.endsWith('cdn.net.') && short.includes('…'), short)
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

test('a link to the builder carries the picks, and reads back as them', () => {
  const p = picks('dns', 'none', '7d', 'day')
  assert.equal(chartLink(p), '#chart?count=dns&split=none&window=7d&over=day')
  assert.equal(chartLink(picks('dns', 'domain', '7d', 'none', 10), { saved: 'k3x9q2m7ab12' }), '#chart?count=dns&split=domain&window=7d&over=none&top=10&saved=k3x9q2m7ab12')
  assert.deepEqual(picksFromParams({ count: 'dns', split: 'none', window: '7d', over: 'day' }), p)
  assert.deepEqual(picksFromParams({ count: 'dns', split: 'domain', window: '7d', over: 'none', top: '10' }), picks('dns', 'domain', '7d', 'none', 10))
  assert.equal(picksFromParams({}), null)
  assert.equal(picksFromParams({ saved: 'x' }), null)
})

test('a link with picks that do not fit snaps to ones that do', () => {
  // Security hits cannot be split by domain or sliced by hour.
  const p = settlePicks(OPTIONS, picksFromParams({ count: 'threats', split: 'domain', window: '24h', over: 'hour', top: '999' }))
  assert.ok(OPTIONS.combos.some((c) => JSON.stringify(c) === JSON.stringify(p)), JSON.stringify(p))
  assert.equal(p.count, 'threats')
  // An unknown count falls back to the first one.
  assert.equal(settlePicks(OPTIONS, picksFromParams({ count: 'cpu', split: 'none', window: '7d', over: 'day' })).count, 'dns')
})

test('no split and no over-time is one total, drawn as a number', () => {
  const p = picks('dns', 'none', '7d', 'none')
  assert.equal(chartKind(p), 'number')
  assert.deepEqual(chartData(OPTIONS, p, [{ 'NetworkNstarDnsActivity.total_query_count': '41208' }], false), [{ name: 'DNS queries', value: 41208 }])
  assert.deepEqual(chartData(OPTIONS, p, [], false), [{ name: 'DNS queries', value: 0 }])
  assert.equal(sentence(OPTIONS, p, false), 'DNS queries, last 7 days')
})

test('bars turn sideways only when a name would be cut short', () => {
  assert.equal(sideways([{ name: 'core-dns-01' }, { name: 'A' }]), false)
  assert.equal(sideways([{ name: 'telemetry.eu.example-cdn-provider.net' }]), true)
})

test('the CSV quotes what a spreadsheet would split on', () => {
  const csv = toCsv({ headers: ['Domain', 'DNS queries'], rows: [['a.example.com', '12'], ['say "hi", ok', '3']] })
  assert.equal(csv, 'Domain,DNS queries\r\na.example.com,12\r\n"say ""hi"", ok",3\r\n')
})

test('a cell starting with = + - or @ is not run as a formula', () => {
  assert.equal(toCsv({ headers: ['x'], rows: [['=1+1'], ['-5'], ['@x']] }), "x\r\n'=1+1\r\n'-5\r\n'@x\r\n")
})

test('choosing no split starts over time again, and one total stays a choice', () => {
  const from = picks('dhcp', 'leaseop', '24h', 'none', 10)
  assert.deepEqual(pickOne(OPTIONS, from, 'split', 'none'), picks('dhcp', 'none', '24h', 'hour'))
  assert.deepEqual(pickOne(OPTIONS, picks('dhcp', 'none', '24h', 'hour'), 'over', 'none'), picks('dhcp', 'none', '24h', 'none'))
})
