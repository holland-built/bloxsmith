// The numbers behind the Value page. The panels and the printed report read
// this one model, so a number can't differ between them. It only reshapes what
// the APIs said: a number that could not be read stays a word, never a 0.
import { valueSecurity } from '../../lib/valueSecurity.js'
import { platformRows } from '../../lib/valuePlatform.js'
import { countReportWork, MINUTES_PER_JOB } from '../../lib/valueWork.js'

export const NO_EARLIER = 'No prior 30-day period available for comparison'
// PortunusAggThreat_ch action Block: threat feeds and policy or content rules together.
export const BLOCKED_COUNTS = 'Includes known threats and lookups blocked by your policy and content rules.'

const LABELS = {
  blocked: 'DNS lookups blocked',
  zero_day: 'Brand-new malicious domains detected',
  sus_to_mal: 'Suspicious sites later confirmed malicious',
  queries: 'DNS queries answered',
  cache_hit: 'Answered from cache',
  roaming: 'Roaming devices protected',
  uptime: 'DNS server uptime',
  dhcp_assigned: 'DHCP addresses assigned',
}

const MISSING = {
  loading: ['Loading…', null],
  error: ['Not checked', 'Infoblox did not respond. This page retries every 5 minutes.'],
  empty: ['No readings', 'Infoblox has no data for this period.'],
  unavailable: ['Not available', 'This data is not available for this account.'],
}

function stat(key, x) {
  const base = { key, label: LABELS[key], state: x.state, line: x.line ?? null, hosts: x.hosts ?? [] }
  if (x.state === 'ok') return { ...base, text: x.text, note: x.note ?? null }
  const [text, why] = MISSING[x.state] ?? MISSING.error
  // The platform API sends its own reason for an unavailable number.
  const reason = x.state === 'unavailable' && key in PLATFORM_KEYS
    ? x.text.replace(/^Not available:\s*/, '')
    : why
  return { ...base, text, note: reason }
}

const PLATFORM_KEYS = { queries: 1, cache_hit: 1, roaming: 1, uptime: 1, dhcp_assigned: 1 }

function workStat(runs, range) {
  const base = { key: 'work', label: 'Bloxsmith jobs completed' }
  if (runs?.loading && !runs?.data) return { ...base, state: 'loading', text: 'Loading…', note: null }
  const w = runs?.error ? null : countReportWork(runs?.data, range)
  if (!w) return { ...base, state: 'error', text: 'Not checked', note: "Bloxsmith's job history could not be read." }
  if (w.noPeriod) return { ...base, state: 'unavailable', text: 'Not available', note: 'Job figures are not available for this report.' }
  const left = w.older > 0 ? `Excludes ${w.older.toLocaleString('en-US')} older ${w.older === 1 ? 'job' : 'jobs'} with no account on record.` : null
  if (w.jobs === 0) return { ...base, state: 'none', text: 'No jobs recorded', note: ['No Bloxsmith jobs are recorded for this account in this period.', left].filter(Boolean).join(' ') }
  const items = `${w.objects.toLocaleString('en-US')} ${w.objects === 1 ? 'object' : 'objects'} created`
  const hours = `an estimated ${w.hours.toLocaleString('en-US')} ${w.hours === 1 ? 'hour' : 'hours'} saved at ${MINUTES_PER_JOB} minutes per job`
  return { ...base, state: 'ok', text: w.jobs.toLocaleString('en-US'), note: [`${items}, ${hours}.`, left].filter(Boolean).join(' ') }
}

const fmtDay = (d, opts) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...opts })

/** "Oct 22 to Nov 20, 2026", or null when the API sent no window. */
export function rangeLabel(range) {
  if (!Array.isArray(range) || range.length !== 2) return null
  return `${fmtDay(range[0])} to ${fmtDay(range[1], { year: 'numeric' })}`
}

/** The day-by-day series with its busiest day. */
export function dailyModel(feed) {
  if (feed?.loading && !feed?.data) return { state: 'loading' }
  if (feed?.error || !feed?.data || feed.data.status === 'error') return { state: 'error' }
  if (feed.data.status !== 'ok' || !Array.isArray(feed.data.days)) return { state: 'empty' }
  const days = feed.data.days.map((d) => ({ day: d.day, value: d.value, label: fmtDay(d.day) }))
  const held = days.filter((d) => d.value != null)
  if (!held.length) return { state: 'empty' }
  const peak = held.reduce((a, d) => (d.value > a.value ? d : a))
  const missing = days.length - held.length
  const gapNote = missing > 0 ? `No data for ${missing} ${missing === 1 ? 'day' : 'days'}. Dashed bars are not values.` : null
  return { state: 'ok', days, peak, peakIndex: days.indexOf(peak), missing, gapNote }
}

/** The active account's own name for the report header. Never an id or the "Tenant 2" placeholder. */
export function accountName(vault) {
  const v = vault?.error ? null : vault?.data
  const t = v?.tenants?.find?.((x) => x.id === v.active)
  const label = typeof t?.label === 'string' ? t.label.trim() : ''
  return label && label !== t.id && !/^Tenant \d+$/.test(label) ? label : null
}

/** One plain sentence built only from numbers that were read. */
export function answerSentence(m) {
  const parts = []
  if (m.blocked.state === 'ok') parts.push(`blocked ${m.blocked.text} DNS lookups`)
  if (m.zero_day.state === 'ok') parts.push(`detected ${m.zero_day.text} brand-new malicious ${m.zero_day.text === '1' ? 'domain' : 'domains'}`)
  if (m.queries.state === 'ok') parts.push(`answered ${m.queries.text} DNS queries`)
  if (!parts.length) return 'Infoblox data could not be read for this period.'
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
  return `Infoblox ${list}.`
}

export function buildModel({ security, platform, runs, daily, vault }) {
  const sec = Object.fromEntries(valueSecurity(security).map((x) => [x.key, x]))
  const plat = Object.fromEntries(platformRows(platform).map((x) => [x.key, x]))
  const range = security?.data?.metrics?.blocked?.window_range
  const m = {
    blocked: stat('blocked', sec.blocked),
    zero_day: stat('zero_day', sec.zero_day),
    sus_to_mal: stat('sus_to_mal', sec.sus_to_mal),
    queries: stat('queries', plat.queries),
    cache_hit: stat('cache_hit', plat.cache_hit),
    roaming: stat('roaming', plat.roaming),
    uptime: stat('uptime', plat.uptime),
    dhcp_assigned: stat('dhcp_assigned', plat.dhcp_assigned),
    work: workStat(runs, range),
    daily: dailyModel(daily),
    range: rangeLabel(range),
    account: accountName(vault),
  }
  // The blocked note already holds its trend or coverage; with neither, say so.
  if (m.blocked.state === 'ok' && !m.blocked.note) m.blocked.note = NO_EARLIER
  return m
}
