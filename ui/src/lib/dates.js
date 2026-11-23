// The one way the app shows a date or time. The viewer's own locale decides the
// order and language; stored and API values are never changed.
const DAY = { month: 'short', day: 'numeric', year: 'numeric' }
const TIME = { hour: 'numeric', minute: '2-digit' }

function toDate(v) {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "Nov 23, 2026" in the viewer's locale, or a dash when there is no real date. */
export function formatDay(v) {
  return toDate(v)?.toLocaleDateString(undefined, DAY) ?? '—'
}

/** "2:05 PM" in the viewer's locale, or a dash when there is no real date. */
export function formatTime(v) {
  return toDate(v)?.toLocaleTimeString(undefined, TIME) ?? '—'
}

/** "Nov 23, 2026, 2:05 PM" in the viewer's locale, or a dash when there is no real date. */
export function formatWhen(v) {
  return toDate(v)?.toLocaleString(undefined, { ...DAY, ...TIME }) ?? '—'
}
