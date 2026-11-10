// The DNS query rate compared like for like: the latest hour against the same
// time a day earlier, so the daily rhythm (quiet nights, busy mornings) never
// reads as a rise or a fall. Comparing with the first hour on the chart did
// exactly that: it set 5 AM against 5 PM.
//
// The feed covers the last 24 hours by the hour, so its oldest hour is usually
// 23 hours back. Any hour 23 to 25 hours before the latest one counts as "the
// same time yesterday", the closest to 24 hours winning. When the feed holds no
// such hour there is no comparison at all, never one against a different hour.

const HOUR_MS = 3600000

/**
 * One hour's reading as a number, or null when the feed sent none. Number()
 * alone turns null and '' into 0, which would show a missing hour as a real
 * zero and a fall of 100%.
 */
export function reading(v) {
  // Only numbers and numeric strings are readings; Number(false) is 0 too.
  if (typeof v !== 'number' && (typeof v !== 'string' || v.trim() === '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** { now, was, nowHour, wasHour, pct } for the latest hour vs a day before, or null. */
export function vsYesterday(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null
  const last = rows[rows.length - 1]
  const tl = new Date(last.hour).getTime()
  if (!Number.isFinite(tl)) return null
  let best = null
  for (const r of rows.slice(0, -1)) {
    const gap = (tl - new Date(r.hour).getTime()) / HOUR_MS
    if (!(gap >= 23 && gap <= 25)) continue
    if (!best || Math.abs(gap - 24) < Math.abs(best.gap - 24)) best = { r, gap }
  }
  if (!best) return null
  const now = reading(last.avg_value)
  const was = reading(best.r.avg_value)
  if (now == null || was == null || was <= 0) return null
  return { now, was, nowHour: last.hour, wasHour: best.r.hour, pct: ((now - was) / was) * 100 }
}

/**
 * The change as shown: "▲ 3%", "▼ 12%" or "±0%". Below one query a second a
 * percentage is noise, so it reads "was 0.4" instead. Never coloured: more DNS
 * traffic is not good news or bad news on its own.
 */
export function changeText(c) {
  if (!c) return null
  if (c.was < 1) return `was ${c.was.toFixed(1)}`
  const d = Math.round(c.pct)
  return d === 0 ? '±0%' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%`
}
