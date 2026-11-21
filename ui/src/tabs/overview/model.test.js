import test from 'node:test'
import assert from 'node:assert/strict'
import { canTellNew, changeSummary, dnsTrend, licenseSummary, openProblems, pageVerdict, rankProblems, upCount } from './model.js'

const svc = (word, sev) => ({ v: { word, sev } })
const NOW = 1_800_000_000

test('the page never says OK while a service is unchecked', () => {
  assert.equal(pageVerdict([svc('Healthy', 'ok'), svc('Not checked', 'none')]).word, 'Status unconfirmed')
  assert.equal(pageVerdict([svc('Healthy', 'ok'), svc('Checking', 'none')]).word, 'Checking')
  assert.equal(pageVerdict([svc('Healthy', 'ok'), svc('Healthy', 'ok')]).word, 'All services healthy')
})

test('a known problem outranks a feed that is still loading', () => {
  const v = pageVerdict([svc('Action required', 'crit'), svc('Checking', 'none'), svc('Review', 'warn')])
  assert.equal(v.word, 'Action required')
  assert.equal(v.line, '1 of 3 services requires action')
})

test('"new" is only claimed once the record is over a day old', () => {
  assert.equal(canTellNew([{ seen: NOW - 60 }], NOW), false)
  assert.equal(canTellNew([{ seen: null }], NOW), false)
  assert.equal(canTellNew([{ seen: NOW - 90000 }, { seen: NOW - 60 }], NOW), true)
})

test('problems rank by severity, then outages before capacity', () => {
  const board = { board: [
    { name: 'IPAM', state: null, issues: [{ key: 'subnet-utilization', sev: 'crit', title: 's', seen: NOW - 60 }] },
    { name: 'Hosts', state: null, issues: [{ key: 'hosts-offline', sev: 'crit', title: 'h', seen: null }] },
    { name: 'DNS', state: { status: 'warn', meta: '3 stopped · 25/28 up' }, issues: [] },
    { name: 'DHCP', state: { status: 'crit', meta: '1 error · 10/18 up' }, issues: [] },
  ] }
  const out = rankProblems(board, NOW)
  assert.deepEqual(out.map((r) => r.key), ['svc-DHCP', 'hosts-offline', 'subnet-utilization', 'svc-DNS'])
  assert.equal(out[0].title, 'DHCP services: 10 of 18 up')
  assert.equal(out.find((r) => r.key === 'subnet-utilization').isNew, false)
})

test('a failing health check is an open problem on its own service', () => {
  assert.deepEqual(upCount('3 stopped · 25/28 up'), { up: 25, total: 28 })
  const dhcp = { name: 'DHCP', state: { status: 'crit', meta: '1 error · 10/18 up' }, issues: [] }
  assert.deepEqual(openProblems(dhcp).map((r) => r.title), ['DHCP services: 10 of 18 up'])
  assert.deepEqual(openProblems({ name: 'DNS', state: { status: 'ok' }, issues: [] }), [])
})

test('a failed feed is an error, never a zero', () => {
  assert.equal(dnsTrend({ data: { status: 'error', rows: [] } }).state, 'error')
  assert.equal(licenseSummary({ data: { status: 'error', licenses: [] } }, NOW * 1000).state, 'error')
  assert.equal(changeSummary({ data: { status: 'error', rows: [], count: 0 } }, NOW * 1000).state, 'unavailable')
})

test('DNS trend reports the real gap between its first and last hour', () => {
  const t = dnsTrend({ data: { rows: [{ hour: '2026-11-20T13:00:00.000', avg_value: 10 }, { hour: '2026-11-21T12:00:00.000', avg_value: 5 }] } })
  assert.equal(t.hours, 23)
  assert.equal(t.pct, -50)
})

test('licenses: expired, due soon and unreadable dates are counted apart', () => {
  const day = 86400000
  const nowMs = NOW * 1000
  const iso = (d) => new Date(nowMs + d * day).toISOString()
  const s = licenseSummary({ data: { licenses: [{ expiry: iso(-1) }, { expiry: iso(30) }, { expiry: iso(400) }, { expiry: 'never?' }] } }, nowMs)
  assert.deepEqual([s.expired, s.soon, s.undated, s.total], [1, 1, 1, 4])
})
