import test from 'node:test'
import assert from 'node:assert/strict'
import { accountName, answerSentence, BLOCKED_COUNTS, buildModel, dailyModel, NO_EARLIER, rangeLabel } from './valueModel.js'

const security = { data: { status: 'ok', metrics: {
  blocked: { status: 'ok', value: 385940, covered: true, previous: null, previous_status: 'partial', window_range: ['2026-10-22', '2026-11-20'] },
  zero_day: { status: 'ok', value: 18 },
  sus_to_mal: { status: 'ok', value: 24, ahead_minutes: 754 },
} } }
const platform = { data: { status: 'ok', metrics: {
  queries: { status: 'ok', unit: 'queries', value: 25917716 },
  cache_hit: { status: 'error', unit: 'percent', value: null },
  roaming: { status: 'empty', unit: 'devices', value: null },
  uptime: { status: 'unavailable', unit: 'percent', value: null, reason: "Not available: Infoblox does not state what its DNS status metric measures." },
  dhcp_assigned: { status: 'unavailable', unit: 'addresses', value: null },
} } }
const model = (over = {}) => buildModel({ security, platform, runs: { data: { tenant: 't', runs: [] } }, daily: { data: { status: 'empty' } }, ...over })

test('a number that was not read is a word, never 0', () => {
  const m = model()
  assert.equal(m.cache_hit.text, 'Not checked')
  assert.equal(m.roaming.text, 'No readings')
  assert.equal(m.uptime.text, 'Not available')
  assert.equal(m.uptime.note, "Infoblox does not state what its DNS status metric measures.")
  for (const s of [m.cache_hit, m.roaming, m.uptime, m.dhcp_assigned]) assert.doesNotMatch(s.text, /\d/)
})

test('no earlier month is said plainly, and a real trend is kept', () => {
  assert.equal(model().blocked.note, NO_EARLIER)
  const m = security.data.metrics.blocked
  const up = model({ security: { data: { status: 'ok', metrics: { ...security.data.metrics, blocked: { ...m, previous: 350000, previous_status: 'ok' } } } } })
  assert.equal(up.blocked.note, 'Up 10% from the previous 30 days')
})

test('no jobs and an unreadable job list are different states', () => {
  assert.equal(model().work.state, 'none')
  assert.equal(model().work.text, 'No jobs recorded')
  assert.equal(model({ runs: { error: new Error('x') } }).work.text, 'Not checked')
})

test('the brand-new label uses a normal hyphen', () => {
  assert.ok(model().zero_day.label.startsWith('Brand-new'))
})

test('daily keeps a real zero apart from a day with no data', () => {
  const d = dailyModel({ data: { status: 'ok', days: [
    { day: '2026-11-01', value: 10 }, { day: '2026-11-02', value: 0 },
    { day: '2026-11-03', value: null }, { day: '2026-11-04', value: 50 },
  ] } })
  assert.equal(d.peak.day, '2026-11-04')
  assert.equal(d.peakIndex, 3)
  assert.equal(d.days[1].value, 0)
  assert.equal(d.days[2].value, null)
  assert.equal(d.missing, 1)
})

test('a failed daily read has no series', () => {
  assert.equal(dailyModel({ data: { status: 'error', days: null } }).state, 'error')
  assert.equal(dailyModel({ error: new Error('x') }).state, 'error')
  assert.equal(dailyModel({ data: { status: 'empty', days: [] } }).state, 'empty')
})

test('the answer sentence only uses numbers that were read', () => {
  assert.equal(answerSentence(model()), 'Infoblox blocked 385,940 DNS lookups, detected 18 brand-new malicious domains and answered 25.9 million DNS queries.')
  const none = buildModel({ security: { error: new Error('x') }, platform: { error: new Error('x') }, runs: {}, daily: {} })
  assert.equal(answerSentence(none), 'Infoblox data could not be read for this period.')
})

test('the blocked number is not called threats', () => {
  assert.equal(model().blocked.label, 'DNS lookups blocked')
  assert.match(BLOCKED_COUNTS, /policy and content/)
})

test('platform numbers keep their explanation and per-server list', () => {
  const up = { ...platform.data.metrics.uptime, status: 'ok', value: 99.5, reason: undefined, hosts: [{ host_name: 'dns-1', value: 99.5 }] }
  const m = model({ platform: { data: { status: 'ok', metrics: { ...platform.data.metrics, uptime: up } } } })
  assert.equal(m.uptime.hosts[0].name, 'dns-1')
  assert.match(m.queries.line, /DNS queries/)
})

test('range label', () => {
  assert.equal(rangeLabel(['2026-10-22', '2026-11-20']), 'Oct 22 to Nov 20, 2026')
  assert.equal(rangeLabel(null), null)
})

// The report: jobs counted inside the days it names, for this account only.
const WINDOW = ['2026-10-22', '2026-11-20']
const secWith = (window_range) => ({ data: { status: 'ok', metrics: { ...security.data.metrics, blocked: { ...security.data.metrics.blocked, window_range } } } })
const job = (extra = {}) => ({ source: 'address', status: 'built', tenant: 't', created: '2026-11-10T12:00:00Z', objects: [{}, {}], ...extra })
const reportWork = (runs, range = WINDOW) => model({ security: secWith(range), runs: { data: { tenant: 't', runs } } }).work

test('the report does not credit jobs with no account on record', () => {
  const w = reportWork([job(), job({ tenant: '' }), job({ tenant: undefined, objects: [{}, {}, {}] })])
  assert.equal(w.text, '1')
  assert.match(w.note, /^2 objects created/)
  assert.match(w.note, /0\.2 hours/)
  assert.match(w.note, /Excludes 2 older jobs with no account on record/)
})

test('only no-account jobs is no jobs for this account, not a count', () => {
  const w = reportWork([job({ tenant: '' })])
  assert.equal(w.state, 'none')
  assert.equal(w.text, 'No jobs recorded')
})

test('report jobs fall inside the whole UTC days the report names', () => {
  const w = reportWork([
    job({ created: '2026-10-21T23:59:59Z', objects: Array(5).fill({}) }),
    job({ created: '2026-10-22T00:00:00Z', objects: [{}] }),
    job({ created: '2026-11-20T23:59:59Z', objects: [{}] }),
    job({ created: '2026-11-21T00:00:00Z', objects: Array(5).fill({}) }),
  ])
  assert.equal(w.text, '2')
  assert.match(w.note, /^2 objects created/)
})

test('with no report period the job figure is not available', () => {
  for (const range of [null, ['2026-10-22'], ['nope', 'nope']]) {
    const w = reportWork([job()], range)
    assert.equal(w.state, 'unavailable')
    assert.equal(w.text, 'Not available')
    assert.doesNotMatch(`${w.text} ${w.note}`, /\d/)
  }
})

test('the printed chart explains days with no data', () => {
  const days = (n) => [{ day: '2026-11-01', value: 5 }, ...Array.from({ length: n }, (_, i) => ({ day: `2026-11-0${i + 2}`, value: null }))]
  assert.equal(dailyModel({ data: { status: 'ok', days: days(2) } }).gapNote, 'No data for 2 days. Dashed bars are not values.')
  assert.equal(dailyModel({ data: { status: 'ok', days: days(1) } }).gapNote, 'No data for 1 day. Dashed bars are not values.')
  assert.equal(dailyModel({ data: { status: 'ok', days: days(0) } }).gapNote, null)
})

test('the account name is the active label, never an id', () => {
  const vault = (active, tenants) => ({ data: { active, tenants } })
  assert.equal(accountName(vault('a1', [{ id: 'a1', label: ' Acme Corp ' }, { id: 'a2', label: 'Other' }])), 'Acme Corp')
  assert.equal(accountName(vault('a1', [{ id: 'a1', label: '' }])), null)
  assert.equal(accountName(vault('a1', [{ id: 'a1', label: 'a1' }])), null)
  assert.equal(accountName(vault('a1', [{ id: 'a1', label: 'Tenant 2' }])), null)
  assert.equal(accountName(vault(null, [])), null)
  assert.equal(accountName({ error: new Error('x') }), null)
})
