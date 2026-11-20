// The Value page's security numbers from /api/csp/value-security, as words
// for the screen: what Infoblox stopped in the last 30 days.
//
// Each number stands on its own. A failed read is "not checked", a read that
// answered without a number is "couldn't tell", and a cube this tenant does
// not have is "not available on this tenant". None of them is ever a 0.

import { reading } from './dnsCompare.js'

export const NOT_CHECKED = 'not checked'
export const COULDNT_TELL = "couldn't tell"
export const NOT_AVAILABLE = 'not available on this tenant'

export const VALUE_SECURITY_ITEMS = [
  { key: 'blocked', label: 'Lookups blocked by your security rules' },
  { key: 'zero_day', label: 'Brand-new dangerous domains caught by Zero Day DNS' },
  { key: 'sus_to_mal', label: 'Sites flagged as suspicious that were later confirmed dangerous' },
]

/** "up 12% on the 30 days before", "down 3% …", "about the same as …", or null. */
export function trendText(value, previous) {
  const now = reading(value)
  const was = reading(previous)
  if (now == null || was == null || was <= 0) return null
  const pct = Math.round(((now - was) / was) * 100)
  if (pct === 0) return 'about the same as the 30 days before'
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toLocaleString()}% on the 30 days before`
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
    if (key === 'blocked') {
      const t = trendText(v, m.previous)
      note = t && t[0].toUpperCase() + t.slice(1)
    }
    if (key === 'sus_to_mal') {
      const a = aheadText(m.ahead_minutes)
      note = a && `Spotted on average ${a} before they were confirmed`
    }
    return { ...base, state: 'ok', text: Math.round(v).toLocaleString(), note }
  })
}
