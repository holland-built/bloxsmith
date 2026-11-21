// The numbers behind the three preview looks of the Value page. Every look
// reads this one model, so a number can't differ between them. It only reshapes
// what the APIs said: a number that could not be read stays a word, never a 0.
import { valueSecurity } from '../../lib/valueSecurity.js'
import { platformRows } from '../../lib/valuePlatform.js'
import { countWork, MINUTES_PER_JOB } from '../../lib/valueWork.js'

export const NO_EARLIER = 'No earlier month to compare'

const LABELS = {
  blocked: 'Lookups blocked by your security rules',
  zero_day: 'Brand-new dangerous domains caught',
  sus_to_mal: 'Suspicious sites later confirmed dangerous',
  queries: 'DNS queries answered',
  cache_hit: 'Answered from cache',
  roaming: 'Laptops protected off the office network',
  uptime: 'DNS server uptime',
  dhcp_assigned: 'DHCP addresses handed out',
}

const MISSING = {
  loading: ['Loading…', null],
  error: ['Not checked', "Infoblox didn't answer. This page tries again every 5 minutes."],
  empty: ['No readings', 'Infoblox has no reading for these 30 days.'],
  unavailable: ['Not available', 'This tenant does not have this data.'],
}

function stat(key, x) {
  const base = { key, label: LABELS[key], state: x.state }
  if (x.state === 'ok') return { ...base, text: x.text, note: x.note ?? null }
  const [text, why] = MISSING[x.state] ?? MISSING.error
  // The platform API sends its own reason for an unavailable number.
  const reason = x.state === 'unavailable' && key in PLATFORM_KEYS
    ? x.text.replace(/^Not available:\s*/, '')
    : why
  return { ...base, text, note: reason }
}

const PLATFORM_KEYS = { queries: 1, cache_hit: 1, roaming: 1, uptime: 1, dhcp_assigned: 1 }

function workStat(runs) {
  const base = { key: 'work', label: 'Jobs done in Bloxsmith' }
  if (runs?.loading && !runs?.data) return { ...base, state: 'loading', text: 'Loading…', note: null }
  const w = runs?.error ? null : countWork(runs?.data)
  if (!w) return { ...base, state: 'error', text: 'Not checked', note: "The list of Bloxsmith's changes could not be read." }
  if (w.jobs === 0) return { ...base, state: 'none', text: 'No jobs yet', note: 'Nothing was built in Bloxsmith on this tenant in these 30 days.' }
  const items = `${w.objects.toLocaleString('en-US')} ${w.objects === 1 ? 'item' : 'items'} made`
  const hours = `about ${w.hours.toLocaleString('en-US')} ${w.hours === 1 ? 'hour' : 'hours'} saved at ${MINUTES_PER_JOB} minutes a job`
  return { ...base, state: 'ok', text: w.jobs.toLocaleString('en-US'), note: `${items}, ${hours}` }
}

const fmtDay = (d, opts) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...opts })

/** "Oct 22 to Nov 20, 2026", or null when the API sent no window. */
export function rangeLabel(range) {
  if (!Array.isArray(range) || range.length !== 2) return null
  return `${fmtDay(range[0])} to ${fmtDay(range[1], { year: 'numeric' })}`
}

/** The day-by-day series with its busiest day, quietest day and average. */
export function dailyModel(feed) {
  if (feed?.loading && !feed?.data) return { state: 'loading' }
  if (feed?.error || !feed?.data || feed.data.status === 'error') return { state: 'error' }
  if (feed.data.status !== 'ok' || !Array.isArray(feed.data.days)) return { state: 'empty' }
  const days = feed.data.days.map((d) => ({ day: d.day, value: d.value, label: fmtDay(d.day) }))
  const held = days.filter((d) => d.value != null)
  if (!held.length) return { state: 'empty' }
  const total = held.reduce((n, d) => n + d.value, 0)
  const peak = held.reduce((a, d) => (d.value > a.value ? d : a))
  const low = held.reduce((a, d) => (d.value < a.value ? d : a))
  const average = total / held.length
  return {
    state: 'ok', days, total, peak, low, average,
    peakIndex: days.indexOf(peak),
    missing: days.length - held.length,
    timesAverage: average > 0 ? peak.value / average : null,
  }
}

/** One plain sentence built only from numbers that were read. */
export function answerSentence(m) {
  const parts = []
  if (m.blocked.state === 'ok') parts.push(`blocked ${m.blocked.text} lookups`)
  if (m.zero_day.state === 'ok') parts.push(`caught ${m.zero_day.text} brand-new dangerous ${m.zero_day.text === '1' ? 'domain' : 'domains'}`)
  if (m.queries.state === 'ok') parts.push(`answered ${m.queries.text} DNS queries`)
  if (!parts.length) return 'Infoblox numbers could not be read for this period.'
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
  return `Infoblox ${list}.`
}

export function buildModel({ security, platform, runs, daily }) {
  const sec = Object.fromEntries(valueSecurity(security).map((x) => [x.key, x]))
  const plat = Object.fromEntries(platformRows(platform).map((x) => [x.key, x]))
  const m = {
    blocked: stat('blocked', sec.blocked),
    zero_day: stat('zero_day', sec.zero_day),
    sus_to_mal: stat('sus_to_mal', sec.sus_to_mal),
    queries: stat('queries', plat.queries),
    cache_hit: stat('cache_hit', plat.cache_hit),
    roaming: stat('roaming', plat.roaming),
    uptime: stat('uptime', plat.uptime),
    dhcp_assigned: stat('dhcp_assigned', plat.dhcp_assigned),
    work: workStat(runs),
    daily: dailyModel(daily),
    range: rangeLabel(security?.data?.metrics?.blocked?.window_range),
  }
  // The blocked note already holds its trend or coverage; with neither, say so.
  if (m.blocked.state === 'ok' && !m.blocked.note) m.blocked.note = NO_EARLIER
  m.supporting = [m.zero_day, m.sus_to_mal, m.queries, m.cache_hit, m.roaming, m.uptime, m.dhcp_assigned, m.work]
  return m
}
