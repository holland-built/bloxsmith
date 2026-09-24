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
 *
 * ---------------------------------------------------------------------------
 * WHY `truncationNote` LIVES HERE AND NOT IN ./sampleCount.js (issue #169).
 *
 * sampleCount.js already solves the general problem: a payload that is a page
 * of something larger, and the words that stop a page size being read as a
 * total. Two things kept this out of it.
 *
 *   1. Blast radius. That file is consumed by the Security panels and is on
 *      this plan's do-not-touch list, so it is read from, never edited. A new
 *      export there would put the audit tab's wording in the same file three
 *      security panels depend on.
 *   2. It would count zero. Its `returnedOf` falls back to `data.events` when
 *      `returned` is absent, and `/api/audit/log` calls its array `entries`.
 *      A cached audit payload run through it would report 0 rows on a screen
 *      showing rows, which is the exact regression its own header records
 *      catching once already.
 *
 * What IS taken from sampleCount.js is the discipline, applied to this
 * payload's own field names: the server's `truncated` flag is the only thing
 * that may declare a page a page (never a `returned < total` comparison), a
 * missing `total` is "unknown" and is said out loud, `total ?? returned` is
 * never written, and the "N+ entries" form is rejected because it reads as a
 * measured lower bound rather than as a page size.
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

/**
 * The line that says the table is only the newest page, or null when it is not.
 *
 * WHY THE FILTER IS NAMED IN THE SENTENCE. The Audit tab filters and sorts in
 * the BROWSER, over the rows it happens to hold. Once the server caps what it
 * sends, typing a filter that matches nothing in the newest page renders "no
 * entries match" while matches sit further back in the log. That empty state is
 * a lie about the log rather than about the page, and no count in a heading
 * fixes it: the reader has to be told that the box they are typing into reaches
 * only what is on screen.
 *
 * `truncated` is the SERVER'S CLAIM and the only trigger. Nothing here infers a
 * page from `returned < total`, per isSample in ./sampleCount.js. A payload
 * from before those fields existed (a tab left open across a deploy, or any
 * cached response) lacks the field entirely, takes the null branch, and renders
 * exactly as it does today.
 *
 * WHY THE SENTENCE ALSO SAYS WHERE THE REST OF THE LOG IS. The cap was justified
 * on the grounds that /api/audit/export stays the complete record
 * (go/internal/server/state.go). A security audit checked whether a reader of
 * this screen can actually reach that mitigation, and found they cannot:
 *
 *     grep -rn "audit/export" ui/src tests docs README.md   ->  no matches
 *
 * There is no Export control anywhere in the app, so the first version of this
 * sentence told a reader what they could not see and then offered them nowhere
 * to go. Adding a download button was REJECTED rather than overlooked:
 * ./panelHelp.js's `audit-log` entry states the log is "Readable and searchable
 * here, but not downloadable", and panelHelpValues.test.js carries that phrase
 * as a deliberate negated claim, so not-downloadable is documented intent and
 * changing it is not a wording fix's call to make.
 *
 * What is left is to name the log itself, following OfflineCheckHint in
 * ../tabs/Audit.jsx, which points at `bloxsmith audit verify` for exactly this
 * reason: an operator who cannot do a thing in the browser still needs to know
 * the option exists at all.
 *
 * Two things the clause is careful NOT to say. It does not claim the command
 * prints entries, because it does not: `bloxsmith audit` has one subcommand,
 * `verify` (go/auditcli.go:81), which reports a verdict, an entry count and the
 * log's path. And it does not name /api/audit/export, because an API route is
 * not an instruction a reader can follow.
 */
//
// `loaded` (issue #172) is how many entries the tab holds once Load older has
// added pages to the newest one. It defaults to `returned`, which is what the
// tab holds before any click. Once everything is loaded the filter reaches the
// whole log, so there is nothing left to warn about.
export function truncationNote(data, loaded = data?.returned) {
  if (data?.truncated !== true) return null

  const returned = loaded
  const total = data?.total
  if (Number.isFinite(returned) && Number.isFinite(total) && returned >= total) return null
  const scope =
    'the filter and search below cover only what is shown here, not the rest of the log, ' +
    'which stays on the server in audit_log.jsonl (bloxsmith audit verify prints its path)'

  if (Number.isFinite(returned) && Number.isFinite(total)) {
    // Only a server that sends first_index can page, so only then is there a
    // Load older button for the sentence to name.
    const more = Number.isFinite(data?.first_index) ? ' Load older fetches the entries before these.' : ''
    return `Showing the newest ${returned.toLocaleString()} of ${total.toLocaleString()} entries; ${scope}.${more}`
  }

  // Malformed payload: the server always sends `total` alongside `truncated`,
  // but a helper that filled the gap with `total ?? returned` would print the
  // page size under the word "of" and be back to the bug sampleCount.js exists
  // for. Unknown is unknown, so the sentence keeps the newest-N framing and
  // drops the figure it does not have.
  const newest = Number.isFinite(returned) ? `the newest ${returned.toLocaleString()} entries` : 'only the newest entries'
  return `Showing ${newest} of a longer log; the full count is not known from this response, and ${scope}.`
}

// ---------- paging back past the cap (issue #172) ----------
//
// A page is {first, entries}: entries[i] sits at position first + i in the log.
// /api/audit/log sends `first_index` for the page it returned, and `?before=N`
// returns the page ending just before position N. The log is append-only, so a
// position never moves and two pages can be joined on it.
//
// What this must never do is show a list with a hole in it, or rows from two
// different logs, while it looks like one continuous log. So a join that would
// leave a gap, or that finds the two pages disagreeing about an entry's hash,
// or that finds the log got shorter, returns null and the caller drops what it
// had loaded.

/** The page a /api/audit/log response describes, or null if it cannot page. */
export function pageOf(data) {
  if (!Number.isFinite(data?.first_index) || !Array.isArray(data?.entries)) return null
  return { first: data.first_index, entries: data.entries }
}

/**
 * `older` followed by `newer`, as one page, or null when they do not join.
 * `newer` must start inside `older` or right after it, and must not end before
 * it. Where they overlap, the entries must carry the same hash; the newer copy
 * is kept. Where they only touch, the first newer entry's prev_hash must name
 * the last older entry, or a log rewritten between the two reads would join.
 */
export function joinPages(older, newer) {
  const olderEnd = older.first + older.entries.length
  const newerEnd = newer.first + newer.entries.length
  if (newer.first < older.first || newer.first > olderEnd || newerEnd < olderEnd) return null
  for (let p = newer.first; p < olderEnd; p++) {
    if (older.entries[p - older.first]?.hash !== newer.entries[p - newer.first]?.hash) return null
  }
  if (newer.first === olderEnd && older.entries.length && newer.entries.length &&
      newer.entries[0]?.prev_hash !== older.entries[older.entries.length - 1]?.hash) return null
  return { first: older.first, entries: older.entries.slice(0, newer.first - older.first).concat(newer.entries) }
}

/**
 * State for the Audit tab's Load older, as a reducer so the poll and a Load
 * older reply cannot overwrite each other's work. State is {gen, view}: `view`
 * is null until the first Load older, then the joined page on screen.
 *
 * `poll` joins each newest page onto the view, so the view keeps up as the
 * newest window slides forward. A gap (more than a page of appends between two
 * polls) or a disagreement drops the view and bumps `gen`.
 *
 * `older` carries the gen it was requested under. A reply from before a reset
 * is ignored, and so is one that does not join (a duplicate click's reply).
 * `data` is the newest page when the request was sent and `latest` the newest
 * page now: a poll that landed while the request was out found no view to join,
 * so the reply joins it here or is dropped.
 */
export function olderPages(state, action) {
  if (action.type === 'poll') {
    const page = pageOf(action.data)
    if (!state.view || !page) return state
    const view = joinPages(state.view, page)
    return view ? { ...state, view } : { gen: state.gen + 1, view: null }
  }
  if (action.type === 'older') {
    if (action.gen !== state.gen) return state
    const base = state.view ?? pageOf(action.data)
    const page = pageOf(action.page)
    if (!base || !page || page.first + page.entries.length !== base.first) return state
    let view = joinPages(page, base)
    const latest = pageOf(action.latest)
    if (view && latest) view = joinPages(view, latest)
    return view ? { ...state, view } : state
  }
  return state
}
