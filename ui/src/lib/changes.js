// Shaping for the "what changed since yesterday" screen (#changes).
//
// Everything here is pure: rows in, shapes out, no fetch and no React, so
// node --test can prove each rule without a browser. The screen itself
// (tabs/Changes.jsx) is a render layer over these functions.
//
// FIELD NAMES — measured against the running server on 2026-08-06, not
// recalled. GET /api/csp-audit?limit=5 answers
//   { count, rows, status, truncated }
// and every row carries exactly:
//   action, id, resource, result, ts, user, who_kind, who_role
// The timestamp is `ts`. `created_at` is the upstream ordering parameter
// (csp.go `_order_by: created_at desc`) and never appears on a row, so no rule
// below may read it.

export const DAY_MS = 24 * 60 * 60 * 1000

/** The `since` query parameter: the instant 24 h before `nowMs`, as ISO. */
export function sinceIso(nowMs) {
  return new Date(nowMs - DAY_MS).toISOString()
}

/** A row's `ts` in ms, or NaN if it is missing or unparseable. */
export function tsMs(row) {
  return Date.parse(row?.ts ?? '')
}

/**
 * Rows whose `ts` falls inside the last 24 h, newest edge included.
 *
 * Both edges are enforced. The server already filters on `since`, so the lower
 * edge is usually a no-op — but P4 promises every rendered row is inside the
 * window, and a row stamped ahead of the browser clock breaks that promise on
 * the upper edge exactly as an old row breaks it on the lower one. A row with
 * no usable `ts` cannot be shown to be inside the window, so it is dropped
 * rather than assumed recent.
 */
export function withinWindow(rows, nowMs) {
  if (!Array.isArray(rows)) return []
  const floor = nowMs - DAY_MS
  return rows.filter((r) => {
    const t = tsMs(r)
    return Number.isFinite(t) && t >= floor && t <= nowMs
  })
}

export const UNKNOWN_RESOURCE = '(unknown resource)'

/** True when `result` is the literal success the server reports. */
export function isSuccess(row) {
  return String(row?.result ?? '').trim().toLowerCase() === 'success'
}

/**
 * Not-success. A blank or missing `result` counts here too: the row did not
 * report success, and calling it successful would invent an outcome nobody
 * read. The band caption says "not reported successful" for that reason.
 */
export function isFailure(row) {
  return !isSuccess(row)
}

/** A delete of any spelling (DELETE, delete, DELETE_RANGE). */
export function isDeletion(row) {
  return /delete/i.test(String(row?.action ?? ''))
}

/**
 * One group per `resource`, newest row first inside each group, groups ordered
 * by their own newest row so the page still reads newest-first at the group
 * level. Counts describe the rows listed in that group and nothing else — the
 * band above counts the whole window, so the two deliberately do not add up.
 */
export function groupByResource(rows) {
  if (!Array.isArray(rows)) return []
  const byResource = new Map()
  for (const row of rows) {
    const key = String(row?.resource ?? '').trim() || UNKNOWN_RESOURCE
    if (!byResource.has(key)) byResource.set(key, [])
    byResource.get(key).push(row)
  }
  const groups = []
  for (const [resource, groupRows] of byResource) {
    const sorted = [...groupRows].sort((a, b) => (tsMs(b) || 0) - (tsMs(a) || 0))
    groups.push({
      resource,
      rows: sorted,
      newestTs: sorted[0]?.ts ?? null,
      total: sorted.length,
      successes: sorted.filter(isSuccess).length,
      failures: sorted.filter(isFailure).length,
      deletions: sorted.filter(isDeletion).length,
    })
  }
  groups.sort((a, b) => (tsMs({ ts: b.newestTs }) || 0) - (tsMs({ ts: a.newestTs }) || 0))
  return groups
}

// ---------- the 500-row cap ----------

/**
 * The hard cap. CSPAudit sends `_limit: "500"` and reports
 * `truncated: len(rows) >= 500` (go/internal/dashboard/csp.go). There is no
 * paging parameter on the route, so this screen cannot fetch past it.
 */
export const ROW_CAP = 500

/** What this screen is allowed to promise, capped or not. */
export const FEED_PROMISE = `the ${ROW_CAP} most recent events in the last 24 hours, newest first`

/**
 * The truncation banner. Deliberately worded as a limit, not a total: with the
 * cap hit, the events NOT on screen are the oldest ones inside the window, and
 * nobody can say how many there were.
 */
export function capNotice(payload) {
  const capped = payload?.truncated === true
  return {
    capped,
    cap: ROW_CAP,
    text: capped
      ? `Capped at ${ROW_CAP} rows. Showing ${FEED_PROMISE}. Older events inside this 24-hour window exist and are not on this screen.`
      : '',
  }
}

// ---------- the span bar ----------

const pad2 = (n) => String(n).padStart(2, '0')

/** hh:mm:ss on the browser's own clock — the same clock the 20:00–08:00 rule uses. */
export function formatClock(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts ?? '')
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * yyyy-mm-dd on the SAME clock formatClock reads.
 *
 * It must not be `ts.slice(0, 10)`. That is the UTC calendar date off the raw
 * string, and it is printed beside a clock rendered in the browser's own zone —
 * so west of Greenwich a late-evening event shows tonight's clock next to
 * tomorrow's date, and east of it an early-morning event shows yesterday's.
 * Both halves have to name the same moment, and local is the half that is
 * fixed: the 20:00–08:00 out-of-hours rule is defined on the browser clock
 * (isOutOfHours), so the date follows the clock, never the other way round.
 */
export function formatDate(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts ?? '')
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** A duration as hh:mm:ss, so the span bar's subtraction can be checked by hand. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`
}

/** Everything the span bar states, over the rows actually listed below it. */
export function feedSummary(rows) {
  const list = Array.isArray(rows) ? rows : []
  const span = dataSpan(list)
  return {
    listed: list.length,
    groups: groupByResource(list).length,
    earliestClock: formatClock(span.earliestTs),
    latestClock: formatClock(span.latestTs),
    spanText: formatDuration(span.spanMs),
  }
}

// ---------- availability ----------

/**
 * loading | unavailable | empty | ok.
 *
 * `unavailable` and `empty` are the pair this app keeps insisting on telling
 * apart: csp.go answers HTTP 200 with `{rows:[],count:0,status:"error"}` when
 * the upstream read fails, and rendering that as "nothing changed" would
 * report a broken feed as a quiet tenant.
 */
export function feedState({ payload, error, loading = false, rowsInWindow = [] } = {}) {
  if (loading) return 'loading'
  if (error || !payload || payload.status === 'error') return 'unavailable'
  return rowsInWindow.length > 0 ? 'ok' : 'empty'
}

// ---------- notability band ----------

export const OOH_START_HOUR = 20
export const OOH_END_HOUR = 8

/** Two hours: the least history that can support a midpoint split at all. */
export const MIN_HISTORY_MS = 2 * 60 * 60 * 1000

export const CAPTIONS = {
  deletions: 'Pulled out because a delete is the only operation with no later state left to inspect.',
  failures:
    'Anything whose result is not "success" — including a result the feed left blank, which is unread rather than fine.',
  outOfHours: `Out of hours means at or after ${OOH_START_HOUR}:00, or before 0${OOH_END_HOUR}:00, on your own local clock — your browser's time zone, not the tenant's.`,
  newActors:
    'This window is split down the middle: an actor counts as new only if it acted in the recent half and never in the earlier half. There is no history before this window, so nothing older can be checked.',
}

export const NOT_ENOUGH_HISTORY = 'not enough history in this window'

/**
 * Out of hours on the BROWSER's local clock, per the caption above:
 * hour >= 20 or hour < 8. A row with no usable `ts` is not claimed either way.
 */
export function isOutOfHours(row) {
  const t = tsMs(row)
  if (!Number.isFinite(t)) return false
  const hour = new Date(t).getHours()
  return hour >= OOH_START_HOUR || hour < OOH_END_HOUR
}

/** Earliest and latest `ts` actually present — the history this page really holds. */
export function dataSpan(rows) {
  const stamps = (Array.isArray(rows) ? rows : []).map(tsMs).filter(Number.isFinite)
  if (stamps.length === 0) return { earliestTs: null, latestTs: null, earliestMs: null, latestMs: null, spanMs: 0, count: 0 }
  const earliestMs = Math.min(...stamps)
  const latestMs = Math.max(...stamps)
  return {
    earliestTs: new Date(earliestMs).toISOString(),
    latestTs: new Date(latestMs).toISOString(),
    earliestMs,
    latestMs,
    spanMs: latestMs - earliestMs,
    count: stamps.length,
  }
}

/**
 * First-time-seen actors, defined so the answer can be non-trivial.
 *
 * The naive rule — "the first row an actor has in this fetch makes it new" —
 * is vacuous: inside one fetched window EVERY actor has a first row, so it
 * marks 100% of actors and says nothing. There is no history store on this
 * app, so all-time novelty is not computable and must not be faked.
 *
 * What is computable: split the window at the midpoint of the data actually
 * present, and call an actor new only if it appears in the recent half and
 * NOT in the earlier half. That is a real comparison with a real negative
 * case, and on the sample above it reports one actor out of three.
 *
 * Two states where even that is a lie, and the category says so instead:
 *   1. `truncated` — the server capped at 500 rows and dropped the OLDEST
 *      events inside the window (`_order_by: created_at desc`), so the earlier
 *      half is not represented and an "absence" there proves nothing.
 *   2. under MIN_HISTORY_MS of data — half of a 40-minute window is not an
 *      earlier half in any useful sense.
 */
export function newActors(rows, { truncated = false } = {}) {
  const span = dataSpan(rows)
  if (truncated) {
    return {
      status: 'unknown',
      actors: [],
      midpointTs: null,
      reason: `the 500-row cap was hit, so the oldest events in this window are missing and the earlier half is not represented`,
    }
  }
  if (span.spanMs < MIN_HISTORY_MS) {
    return {
      status: 'unknown',
      actors: [],
      midpointTs: null,
      reason: 'this window holds under 2 hours of events, which is too little to split into an earlier and a recent half',
    }
  }
  const midpointMs = span.earliestMs + span.spanMs / 2
  const earlier = new Set()
  const recent = new Set()
  for (const row of rows) {
    const t = tsMs(row)
    if (!Number.isFinite(t)) continue
    const actor = String(row?.user ?? '').trim()
    if (!actor) continue
    ;(t > midpointMs ? recent : earlier).add(actor)
  }
  return {
    status: 'ok',
    actors: [...recent].filter((a) => !earlier.has(a)).sort(),
    midpointTs: new Date(midpointMs).toISOString(),
    reason: '',
  }
}

/**
 * The four cells of the notability band, always all four, in the locked order
 * from the approved design. `state` is what the cell renders:
 *   populated — a real count
 *   none      — a proven zero
 *   unknown   — the question could not be answered honestly (new actors only)
 */
export function notability(rows, { truncated = false } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const cell = (key, label, rowsMatched) => ({
    key,
    label,
    count: rowsMatched.length,
    rows: rowsMatched,
    state: rowsMatched.length > 0 ? 'populated' : 'none',
    chip: rowsMatched.length > 0 ? label : 'None',
    caption: CAPTIONS[key],
  })

  const actors = newActors(list, { truncated })
  return [
    cell('deletions', 'Deletions', list.filter(isDeletion)),
    cell('failures', 'Failed changes', list.filter(isFailure)),
    cell('outOfHours', 'Out of hours', list.filter(isOutOfHours)),
    {
      key: 'newActors',
      label: 'New actors this window',
      count: actors.actors.length,
      rows: [],
      actors: actors.actors,
      state: actors.status === 'unknown' ? 'unknown' : actors.actors.length > 0 ? 'populated' : 'none',
      chip: actors.status === 'unknown' ? 'Unknown' : actors.actors.length > 0 ? 'New' : 'None',
      caption: CAPTIONS.newActors,
      reason: actors.reason,
      midpointTs: actors.midpointTs,
    },
  ]
}
