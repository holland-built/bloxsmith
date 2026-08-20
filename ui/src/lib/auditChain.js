/**
 * Turning `/api/audit/log` entries into rows the Audit tab can render.
 *
 * THE BUG THIS EXISTS FOR (issue #168). The Audit tab's "Audit Log" panel, whose
 * note reads "Bloxsmith actions" and whose help reads "Every change made through
 * this app", was rendering `data.rows('auditLogs')` — the `_limit: 100` slice of
 * the INFOBLOX PORTAL audit feed (go/internal/dashboard/dashboard.go:625, whose
 * own comment says "CSP portal audit"). The panel directly below it renders the
 * same upstream feed at `_limit: 500`, correctly labelled "external".
 *
 * So the tab showed the portal log twice and this app's own log zero times,
 * while printing "chain intact — signature and entry count verified" above rows
 * that were not from that chain. Measured on the live tenant 2026-08-20: 100
 * portal rows on screen, 837 chain entries fetched by the same component and
 * discarded.
 *
 * The two feeds do not share a shape, which is what this module is for:
 *
 *   portal row   {ts: "2026-08-20T14:54:18.899007Z", user, action, resource, result}
 *   chain entry  {ts: 1784580619.265203, actor, event, detail: {...}, hash, seq}
 *
 * `ts` is the trap. It is an ISO string in one and FLOAT EPOCH SECONDS in the
 * other, and `new Date(1784580619.265)` is a date in 1970 — silently, with no
 * error, in both the cell and the sort comparator. Every field is normalised
 * once here rather than at each of the several places Audit.jsx touched a row,
 * because the previous arrangement is what let one shape be swapped for another
 * without anything noticing.
 */

/**
 * Milliseconds since the epoch, or null when the entry carries no usable time.
 *
 * Accepts the float seconds the chain writes, a numeric string (json.Number
 * survives a round trip that way on some paths), and an ISO string — the last
 * so a caller cannot produce 1970 by handing this a portal row by mistake.
 * Anything else is null, which the formatter renders as an em-less dash rather
 * than as a date nobody can defend.
 */
export function entryTimeMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts * 1000
  if (typeof ts === 'string') {
    const s = ts.trim()
    if (s === '') return null
    // A bare number in a string is still epoch seconds. Testing the string
    // BEFORE Date.parse matters: Date.parse("1784580619.265") is not a
    // rejection in every engine, it is a garbage date.
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s)
      return Number.isFinite(n) ? n * 1000 : null
    }
    const parsed = Date.parse(s)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/**
 * The `detail` object as one readable line.
 *
 * Keys sorted so two entries of the same kind line up down the column, and
 * `image_digest`/`instance_id` dropped: they are on EVERY entry (measured: 837
 * of 837), they are a property of the build that wrote the line rather than of
 * the thing that happened, and leaving them in pushes the fields that differ off
 * the end of the cell.
 */
const DETAIL_NOISE = new Set(['image_digest', 'instance_id'])

export function detailText(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return ''
  return Object.keys(detail)
    .filter((k) => !DETAIL_NOISE.has(k))
    .sort()
    .map((k) => {
      const v = detail[k]
      const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return `${k}=${s}`
    })
    .join(' · ')
}

/**
 * One render-ready row per chain entry.
 *
 * `_ms` is what the Time column formats and what the sort compares, so the two
 * can no longer disagree. `_search` is the haystack the filter box matches, built
 * once per row instead of per keystroke.
 *
 * Entries arrive oldest-first (it is an append-only chain). They are NOT sorted
 * here — the panel owns sort direction, and a normaliser that quietly reordered
 * would make the default order a thing two files argue about.
 */
export function chainRows(entries) {
  if (!Array.isArray(entries)) return []
  return entries.map((e, i) => {
    const detail = detailText(e?.detail)
    const actor = String(e?.actor ?? '')
    const event = String(e?.event ?? '')
    return {
      // seq is the chain's own index and is absent on entries written before it
      // existed (measured: 718 of 837 have it). Falling back to the array index
      // keeps React keys unique without implying the older entries were numbered.
      _key: Number.isFinite(e?.seq) ? `seq-${e.seq}` : `idx-${i}`,
      _ms: entryTimeMs(e?.ts),
      actor,
      event,
      detail,
      _search: `${actor} ${event} ${detail}`.toLowerCase(),
    }
  })
}

/**
 * How many entries of each event kind, most frequent first.
 *
 * DELIBERATELY NOT an outcome verdict. The first version of this split the
 * entries into "recorded" and "refused" by testing for one event name, which
 * conflates several things: a refusal IS recorded, and `*-error`, `rbac_denied`
 * and `*-unreadable` all encode a failure the split would have filed as a
 * success. Event names are what the log actually stores, so event names are what
 * gets counted, and a kind this code has never seen counts correctly on the day
 * it is added.
 */
export function eventTally(entries) {
  const counts = new Map()
  for (const e of Array.isArray(entries) ? entries : []) {
    const k = String(e?.event ?? '').trim() || 'unnamed'
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event))
}

/**
 * The line that says the table is short, or null when it is not.
 *
 * Reads the two fields `/api/audit/log` sends only when it has something to
 * report (go/internal/server/state.go). Both can be set at once — an unreadable
 * file and dropped lines are different failures — so both are said.
 */
export function readShortfall(data) {
  const parts = []
  if (typeof data?.read_error === 'string' && data.read_error !== '') {
    parts.push(`the log could not be read (${data.read_error})`)
  }
  const skipped = data?.skipped_lines
  if (Number.isFinite(skipped) && skipped > 0) {
    parts.push(`${skipped.toLocaleString()} line${skipped === 1 ? '' : 's'} on disk could not be decoded and are missing below`)
  }
  return parts.length ? parts.join('; ') : null
}
