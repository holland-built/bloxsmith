import test from 'node:test'
import assert from 'node:assert/strict'
import { answerSentence, buildModel, dailyModel, NO_EARLIER, rangeLabel } from './looksData.js'

const security = { data: { status: 'ok', metrics: {
  blocked: { status: 'ok', value: 385940, covered: true, previous: null, previous_status: 'partial', window_range: ['2026-10-22', '2026-11-20'] },
  zero_day: { status: 'ok', value: 18 },
  sus_to_mal: { status: 'ok', value: 24, ahead_minutes: 754 },
} } }
const platform = { data: { status: 'ok', metrics: {
  queries: { status: 'ok', unit: 'queries', value: 25917716 },
  cache_hit: { status: 'error', unit: 'percent', value: null },
  roaming: { status: 'empty', unit: 'devices', value: null },
  uptime: { status: 'unavailable', unit: 'percent', value: null, reason: "Not available: Infoblox doesn't say what its DNS status number measures." },
  dhcp_assigned: { status: 'unavailable', unit: 'addresses', value: null },
} } }
const model = (over = {}) => buildModel({ security, platform, runs: { data: { tenant: 't', runs: [] } }, daily: { data: { status: 'empty' } }, ...over })

test('a number that was not read is a word, never 0', () => {
  const m = model()
  assert.equal(m.cache_hit.text, 'Not checked')
  assert.equal(m.roaming.text, 'No readings')
  assert.equal(m.uptime.text, 'Not available')
  assert.equal(m.uptime.note, "Infoblox doesn't say what its DNS status number measures.")
  for (const s of m.supporting) if (s.state !== 'ok') assert.doesNotMatch(s.text, /^0/)
})

test('no earlier month is said plainly, and a real trend is kept', () => {
  assert.equal(model().blocked.note, NO_EARLIER)
  const m = security.data.metrics.blocked
  const up = model({ security: { data: { status: 'ok', metrics: { ...security.data.metrics, blocked: { ...m, previous: 350000, previous_status: 'ok' } } } } })
  assert.equal(up.blocked.note, 'Up 10% on the 30 days before')
})

test('no jobs and an unreadable job list are different states', () => {
  assert.equal(model().work.state, 'none')
  assert.equal(model().work.text, 'No jobs yet')
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
  assert.equal(d.total, 60)
  assert.equal(d.average, 20)
  assert.equal(d.peak.day, '2026-11-04')
  assert.equal(d.peakIndex, 3)
  assert.equal(d.low.day, '2026-11-02')
  assert.equal(d.missing, 1)
})

test('a failed daily read has no series', () => {
  assert.equal(dailyModel({ data: { status: 'error', days: null } }).state, 'error')
  assert.equal(dailyModel({ error: new Error('x') }).state, 'error')
  assert.equal(dailyModel({ data: { status: 'empty', days: [] } }).state, 'empty')
})

test('the answer sentence only uses numbers that were read', () => {
  assert.equal(answerSentence(model()), 'Infoblox blocked 385,940 lookups, caught 18 brand-new dangerous domains and answered 25.9 million DNS queries.')
  const none = buildModel({ security: { error: new Error('x') }, platform: { error: new Error('x') }, runs: {}, daily: {} })
  assert.equal(answerSentence(none), 'Infoblox numbers could not be read for this period.')
})

test('range label', () => {
  assert.equal(rangeLabel(['2026-10-22', '2026-11-20']), 'Oct 22 to Nov 20, 2026')
  assert.equal(rangeLabel(null), null)
})
