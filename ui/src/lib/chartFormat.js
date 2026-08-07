// How a chart says a number or a date to somebody who is not an engineer.
//
// Every chart in this app used to make this decision on its own, which is why
// hovering one produced `value : 346.1144444444444` — recharts' default, and a
// fair description of what the code holds, but not of what anyone measured. The
// average behind that float came from a feed with three significant digits.
//
// Written as pure functions with no React and no recharts import so they can be
// tested (see chartFormat.test.js); the component that draws the tooltip is
// ChartTip in ../components/ui.jsx.

const DASH = '—'

// One decimal, never two. The dashboard's own KPI headline already rounds this
// way (Overview.jsx renders `maximumFractionDigits: 1` above the same series),
// so the tooltip and the big number now agree instead of disagreeing by ten
// digits.
function toNum(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export function fmtValue(v) {
  const n = toNum(v)
  if (n === null) return DASH
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Deliberately NOT `new Date(s).toLocaleDateString()`. These timestamps arrive
// as UTC midnight, and anywhere west of Greenwich the Date route renders the
// previous day — a chart that silently relabels every bar by one day is worse
// than the raw ISO string it replaced. Reading the digits out of the string is
// the only version that cannot drift.
//
// Anything that is not an ISO date is handed back untouched, because several
// charts already label their points with a clock time ("03:00 PM") or a word
// ("CREATE"). A number is NOT handed back: a bare index is what dns-query-volume-7d
// was drawing when it fell through to `r.hour ?? i`, and "0" is not a date.
export function fmtShortDay(s) {
  if (typeof s !== 'string' || s === '') return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return s
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return s
  return `${month} ${Number(m[3])}`
}

// The DNSSEC panel's count line. The word this replaces is "worst", which the
// data cannot support: the rows carry fqdn / view / status / policy and nothing
// that ranks one unsigned zone above another, so "worst 150" was really "the
// first 150 the upstream happened to return". Naming the A–Z sort says which
// 150 you are looking at and makes the cut the same on every reload.
export function dnssecPanelLabel(unsignedCount, cap) {
  const n = toNum(unsignedCount)
  if (n === null || n <= 0) return ''
  if (n > cap) return `first ${cap.toLocaleString()} of ${n.toLocaleString()} unsigned (A–Z)`
  return `${n.toLocaleString()} unsigned`
}
