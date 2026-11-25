import test from 'node:test'
import assert from 'node:assert/strict'
import { canTellNew, changeSummary, dnsTrend, emptyListWords, licenseSummary, newIssuesWords, openProblems, pageVerdict, rankProblems, upCount, vsWords } from './model.js'

const svc = (word, sev) => ({ v: { word, sev } })
const NOW = 1_800_000_000

test('the page never says OK while a service is unchecked', () => {
  assert.equal(pageVerdict([svc('Healthy', 'ok'), svc('Not checked', 'none')]).word, 'Status unconfirmed')
  assert.equal(pageVerdict([svc('Healthy', 'ok'), svc('Checking', 'none')]).word, 'Checking')
  assert.equal(pageVerdict([svc('Healthy', 'ok'), svc('Healthy', 'ok')]).word, 'All services healthy')
})

test('a known problem outranks a feed that is still loading', () => {
  const v = pageVerdict([svc('Needs action', 'crit'), svc('Checking', 'none'), svc('Review', 'warn')])
  assert.equal(v.word, 'Needs action')
  assert.equal(v.line, '1 of 3 services requires action')
})

test('an incident outside the five services still sets the verdict', () => {
  const ok = [svc('Healthy', 'ok'), svc('Healthy', 'ok')]
  assert.equal(pageVerdict(ok, [{ sev: 'crit' }]).word, 'Needs action')
  assert.equal(pageVerdict(ok, [{ sev: 'crit' }]).line, '1 other incident requires action')
  assert.equal(pageVerdict(ok, [{ sev: 'warn' }, { sev: 'warn' }]).line, '2 other incidents require review')
  assert.equal(pageVerdict(ok, [{ sev: 'note' }]).word, 'All services healthy')
  assert.equal(pageVerdict([svc('Act', 'crit'), svc('Healthy', 'ok')], [{ sev: 'crit' }]).line, '1 of 2 services requires action, plus 1 other incident')
})

test('"None" new is only said over complete, fully dated records', () => {
  const old = { seen: NOW - 90000, isNew: false }
  const words = (problems, allRead = true, reading = false) => newIssuesWords({ problems, allRead, reading, nowS: NOW })
  assert.equal(words([old]), 'None in the last 24 hours')
  assert.equal(words([old, { seen: null }]), 'None among dated issues. 1 issue has no date.')
  assert.equal(words([old], false), 'Not yet available. Some sources could not be read.')
  assert.equal(words([old, { seen: NOW - 60, isNew: true }]), '1 opened in the last 24 hours')
  assert.equal(words([old, { seen: NOW - 60, isNew: true }, { seen: null }]), '1 opened in the last 24 hours, counting dated issues only')
  assert.equal(words([old], true, true), 'Checking…')
})

test('a blank change result is unknown, never failed', () => {
  const nowMs = NOW * 1000
  const ts = new Date(nowMs - 60000).toISOString()
  const rows = ['success', 'failure', 'failure', 'unknown', '', undefined].map((result) => ({ ts, result }))
  const s = changeSummary({ data: { status: 'ok', truncated: false, rows } }, nowMs)
  assert.deepEqual([s.total, s.failed, s.noResult], [6, 2, 3])
})

test('a partial source keeps the verdict unconfirmed unless action is required', () => {
  const partial = (word, sev) => ({ v: { word, sev }, b: { partial: true } })
  assert.equal(pageVerdict([svc('Healthy', 'ok'), partial('Partly checked', 'none')]).word, 'Status unconfirmed')
  const look = pageVerdict([svc('Healthy', 'ok'), partial('Review', 'warn')])
  assert.equal(look.word, 'Status unconfirmed')
  assert.equal(look.line, '1 of 2 services could not be fully checked, 1 item requires review')
  assert.equal(pageVerdict([partial('Needs action', 'crit'), partial('Partly checked', 'none')]).word, 'Needs action')
})

test('a capped log with no usable dates has an undetermined period', () => {
  const s = changeSummary({ data: { status: 'ok', truncated: true, rows: [{ ts: 'not a date', result: 'success' }] } }, NOW * 1000)
  assert.equal(s.state, 'undetermined')
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

test('a failing service links to its own down list', () => {
  const b = (name) => ({ name, state: { status: 'crit', meta: '1 error · 10/18 up' }, issues: [] })
  assert.deepEqual(['DHCP', 'DNS', 'Security'].map((n) => openProblems(b(n))[0].href), [
    '#infra?service=DHCP&status=down',
    '#infra?service=DNS&status=down',
    '#infra?service=Security&status=down',
  ])
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

test('an empty attention list never reads as fine when no service could be checked', () => {
  const dead = [svc('Unavailable', 'none'), svc('Not checked', 'none')]
  assert.equal(emptyListWords(dead, pageVerdict(dead)), 'No services could be checked, so issues may be missing from this list.')
  const some = [svc('Healthy', 'ok'), svc('Not checked', 'none')]
  assert.equal(emptyListWords(some, pageVerdict(some)), 'No issues found so far.')
  const ok = [svc('Healthy', 'ok')]
  assert.equal(emptyListWords(ok, pageVerdict(ok)), 'No items require attention.')
})

test('subnets 90% full with no incident are an open IPAM problem, so the list matches the Review tile', () => {
  const ipam = { name: 'IPAM', href: '#network?minUtil=90&links=1', n: 1, issues: [], state: null }
  const open = openProblems(ipam)
  assert.equal(open.length, 1)
  assert.equal(open[0].title, '1 subnet is 90% full or more')
  assert.equal(open[0].sev, 'warn')
  assert.equal(rankProblems({ board: [ipam] }, NOW)[0].action, 'View subnets')
  // An incident already about it is enough; no second row.
  assert.equal(openProblems({ ...ipam, issues: [{ key: 'subnet-utilization', sev: 'warn' }] }).length, 1)
  assert.equal(openProblems({ ...ipam, n: 0 }).length, 0)
})

test('the DNS change says the real window, the same words on the tile and the chart', () => {
  const t = dnsTrend({ data: { rows: [{ hour: '2026-01-01T04:00:00', avg_value: 100 }, { hour: '2026-01-01T06:00:00', avg_value: 125 }] } })
  assert.equal(vsWords(t.hours), 'vs 2h ago')
  assert.equal(vsWords(null), 'vs first hour')
})
