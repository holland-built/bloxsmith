// The Value page's security numbers from /api/csp/value-security, as words
// for the screen: what Infoblox stopped in the last 30 days.
//
// Each number stands on its own. A failed read is "not checked", a read that
// answered without a number is "couldn't tell", and a cube this tenant does
// not have is "not available on this tenant". None of them is ever a 0.

import { reading } from './dnsCompare.js'
import { fmtShortDay } from './chartFormat.js'

export const NOT_CHECKED = 'not checked'
export const COULDNT_TELL = "couldn't tell"
export const NOT_AVAILABLE = 'not available on this tenant'

export const VALUE_SECURITY_ITEMS = [
  { key: 'blocked', label: 'Lookups blocked by your security rules' },
  { key: 'zero_day', label: 'Brand-new dangerous domains caught by Zero Day DNS' },
  { key: 'sus_to_mal', label: 'Sites flagged as suspicious that were later confirmed dangerous' },
]

/** "up 12% from the previous 30 days", "down 3% …", "about the same as …", or null. */
export function trendText(value, previous) {
  const now = reading(value)
  const was = reading(previous)
  if (now == null || was == null || was <= 0) return null
  const pct = Math.round(((now - was) / was) * 100)
  if (pct === 0) return 'about the same as the previous 30 days'
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toLocaleString()}% from the previous 30 days`
}

/** Minutes as the plainest whole unit: "45 minutes", "13 hours", "3 days". */
export function aheadText(minutes) {
  const m = reading(minutes)
  if (m == null || m <= 0) return null
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
  if (m < 120) return plural(Math.round(m), 'minute')
  if (m < 48 * 60) return plural(Math.round(m / 60), 'hour')
  return plural(Math.round(m / 1440), 'day')
}

/**
 * The line under the blocked number. When Infoblox does not hold all 30 days
 * the number is not a 30-day total, so the line says which days it counts and
 * there is no trend. covered null means that could not be checked.
 */
export function blockedNote(m, value) {
  if (m.covered === false) {
    if (!m.days_from) return 'Infoblox holds no readings for these 30 days'
    // Days missing between the first and last held: neither "since" nor a range is true.
    if (m.days_held < daysSpanned(m.days_from, m.days_to)) return `Counted ${m.days_held} of these 30 days, the days Infoblox holds`
    const [first, last] = Array.isArray(m.window_range) ? m.window_range : []
    // The newest day can still be landing, so ending the day before is whole.
    const endsEarly = last && m.days_to && m.days_to < dayBefore(last)
    if (first && m.days_from > first && !endsEarly) return `Counted since ${fmtShortDay(m.days_from)}, the earliest day Infoblox holds`
    return `Counted ${fmtShortDay(m.days_from)} to ${fmtShortDay(m.days_to)} only, the days Infoblox holds`
  }
  if (m.covered == null) return "Could not confirm that Infoblox holds all 30 days"
  const t = trendText(value, m.previous)
  return t && t[0].toUpperCase() + t.slice(1)
}

/** How many days first..last spans, counting both ends. */
function daysSpanned(first, last) {
  return Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000) + 1
}

/** The day before a YYYY-MM-DD day, as YYYY-MM-DD. */
function dayBefore(d) {
  const t = new Date(`${d}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() - 1)
  return t.toISOString().slice(0, 10)
}

/**
 * The three numbers as { key, label, state, text, note }. state is 'loading',
 * 'ok', 'empty', 'error' or 'unavailable'; text is the big number or the word
 * that stands in for it; note is a second line or null.
 */
export function valueSecurity(feed) {
  return VALUE_SECURITY_ITEMS.map(({ key, label }) => {
    const base = { key, label, note: null }
    if (feed?.loading && !feed?.data) return { ...base, state: 'loading', text: 'Loading…' }
    const m = feed?.error ? null : feed?.data?.metrics?.[key]
    if (!m || m.status === 'error') return { ...base, state: 'error', text: NOT_CHECKED }
    if (m.status === 'unavailable') return { ...base, state: 'unavailable', text: NOT_AVAILABLE }
    const v = reading(m.value)
    if (m.status !== 'ok' || v == null) return { ...base, state: 'empty', text: COULDNT_TELL }
    let note = null
    if (key === 'blocked') note = blockedNote(m, v)
    if (key === 'sus_to_mal') {
      const a = aheadText(m.ahead_minutes)
      note = a && `Identified an average of ${a} before confirmation`
    }
    return { ...base, state: 'ok', text: Math.round(v).toLocaleString(), note }
  })
}
