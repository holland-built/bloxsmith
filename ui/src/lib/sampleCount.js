
import { formatTime } from './dates.js'/**
 * Saying whose numbers these are, when a panel's figures were counted from a
 * capped page rather than from everything that happened.
 *
 * THE BUG THIS EXISTS FOR (issue #157). `/api/hub/security` is fetched with a
 * row limit, and every figure it publishes — the severity counts, blocked,
 * logged — is derived by looping the rows that came back. It used to publish
 * `"total": len(rows)` as well, so three panels printed a count OF THE SAMPLE
 * under labels that read as the hour. Measured on the live tenant on
 * 2026-08-20: 50 rows against a limit of 50, and a tile labelled "Total Events"
 * showing 50 for an hour whose real count nobody had asked for.
 *
 * The server now sends `returned` (the rows listed), `counted` (the events the
 * figures cover), `complete` (whether that is the whole window), `truncated`
 * (its inverse), and `total` ONLY when the true figure is known. These helpers
 * are the single place that turns those into words, so the panels cannot drift
 * into describing the same payload differently.
 *
 * WHY `total` IS NEVER SUBSTITUTED FOR `returned`. A consumer writing
 * `total ?? rows.length` is back to printing the sample under the old label,
 * which is exactly how this bug survived. Every function here treats a missing
 * total as "unknown" and says so.
 */

/**
 * Is this payload a sample of something larger?
 *
 * Both the flag and, when present, the comparison — the flag is the server's
 * claim and the number is the check that it is coherent. Same rule as
 * feedCountLabel in ./feedCount.js.
 */
export function isSample(data) {
  return data?.truncated === true
}

/**
 * How many rows this payload was counted from.
 *
 * FALLS BACK TO THE EVENTS ARRAY, and that is not belt-and-braces. The first
 * version of this file read `data.returned` alone, and the page-baseline suite
 * caught it immediately: a payload from before `returned` existed rendered
 * "0 events" on a page showing two of them. A browser tab left open across a
 * deploy holds exactly that payload, and so does any cached response — so the
 * new code would have replaced one wrong number with a worse one, on a security
 * panel, for anyone who had not reloaded.
 *
 * Counting the rows is only dangerous when the count gets LABELLED as a total.
 * That decision belongs to `truncated`, which an old payload also lacks, so an
 * old payload takes the unqualified branch below and reads exactly as it did
 * before any of this changed.
 */
function returnedOf(data) {
  if (Number.isFinite(data?.returned)) return data.returned
  return Array.isArray(data?.events) ? data.events.length : 0
}

/**
 * How many events the figures cover. A payload from before `counted` existed
 * counted only the rows it listed, so it falls back to those.
 */
export function countedOf(data) {
  return Number.isFinite(data?.counted) ? data.counted : returnedOf(data)
}

/** The authoritative estate figure, or null when nobody published one. */
export function knownTotal(data) {
  const total = data?.total
  return Number.isFinite(total) ? total : null
}

/**
 * The count that goes beside a panel heading.
 *
 * @param {object|undefined} data the `/api/hub/security` payload
 * @param {string} noun what is being counted, e.g. "events"
 * @returns {string} heading text; callers handle the feed-dead case themselves
 */
export function sampleCountLabel(data, noun) {
  const counted = countedOf(data)
  if (!isSample(data)) return `${counted.toLocaleString()} ${noun}`

  const total = knownTotal(data)
  if (total !== null) {
    return `${counted.toLocaleString()} of ${total.toLocaleString()} ${noun}`
  }
  if (Number.isFinite(data?.counted)) return `newest ${counted.toLocaleString()} ${noun}`
  // Truncated with no total is the honest dead end: there ARE more, and how
  // many is not knowable from this response. "50+ events" was rejected as the
  // wording because it reads as a measured lower bound of the hour rather than
  // as a page size.
  return `${counted.toLocaleString()} ${noun} shown, total unknown`
}

/**
 * The one line that goes under a grid of figures which were all counted from
 * the sample. Null when there is nothing to disclaim, so a panel showing
 * complete data stays clean.
 *
 * One line under the grid rather than a suffix on each figure: four chips each
 * reading "critical (of 50 shown)" is noise that stops being read, and the
 * scope is a property of the panel, not of any one number in it.
 */
export function sampleScopeNote(data, noun) {
  if (!isSample(data)) return null
  const returned = returnedOf(data)
  const total = knownTotal(data)
  const of = total !== null ? ` of ${total.toLocaleString()}` : ''
  if (Number.isFinite(data?.counted)) {
    return `Covers only the newest ${data.counted.toLocaleString()}${of} ${noun} in this window.`
  }
  return `Counted from the ${returned.toLocaleString()}${of} ${noun} shown, not the whole window.`
}

/**
 * What a list shows when it is shorter than the count above it, or null when
 * it shows everything counted.
 *
 * `legend` is the sum of the severity counts printed beside the list, when
 * there is one. A payload without `counted` used to get no note at all, so
 * Security printed "2 events" over a legend of 1 + 2 + 3 + 4 = 10 and bars
 * drawn from the 2 listed rows, with nothing saying why (2026-11-24).
 */
export function shownNote(data, noun, legend = 0) {
  const total = Math.max(Number.isFinite(data?.counted) ? data.counted : 0, Number(legend) || 0)
  const returned = returnedOf(data)
  if (!total || returned >= total) return null
  const shown = returned.toLocaleString()
  const counted = total.toLocaleString()
  return isSample(data)
    ? `Showing the newest ${shown} of the ${counted} ${noun} counted.`
    : `Showing the newest ${shown} of ${counted} ${noun}.`
}

/**
 * The scope of a figure worked out from the listed rows alone, or null when
 * those rows are everything counted. Acknowledgements are per listed row, so
 * such a figure cannot speak for the rest of the hour.
 */
export function shownOnlyLabel(data) {
  if (!Number.isFinite(data?.counted)) return null
  const returned = returnedOf(data)
  return returned < data.counted ? `newest ${returned.toLocaleString()}` : null
}

/**
 * The label and value for a single "how many were there" tile.
 *
 * The tile in Security's Response Summary said "Total Events" over
 * `total ?? events.length`, which is the defect in its purest form. When the
 * total is genuinely known the label is right and the number is now the real
 * one. When it is not, the tile stops claiming to be a total rather than
 * printing a page size under that word.
 *
 * @returns {{label: string, value: number}}
 */
export function totalEventsTile(data, totalLabel, sampleLabel) {
  const returned = returnedOf(data)
  const total = knownTotal(data)
  if (total !== null) return { label: totalLabel, value: total }
  // Not truncated and no total means the rows in hand ARE everything in the
  // window, so "total" is accurate without upstream having to say so.
  if (!isSample(data)) return { label: totalLabel, value: countedOf(data) }
  if (Number.isFinite(data?.counted)) return { label: 'Events Counted', value: data.counted }
  return { label: sampleLabel, value: returned }
}

/**
 * The time the oldest of a sampled feed's events happened, as a short clock
 * time ("10:47 PM"), or null when there are no times to read.
 *
 * "20 in the latest 50 events" read as a total, and the next load's 4 read as
 * good news. Saying when the 50 start ("since 10:47 PM") makes it plain that
 * the window is minutes long and moves.
 */
export function sampleSince(data, now = new Date()) {
  // The server names the oldest event it counted, which can be far older than
  // the oldest one listed.
  const source = data?.counted_since ? [{ event_time: data.counted_since }] : data?.events ?? []
  const times = source.map((e) => Date.parse(e?.event_time)).filter((t) => Number.isFinite(t))
  if (!times.length) return null
  const oldest = new Date(Math.min(...times))
  const sameDay = oldest.toDateString() === now.toDateString()
  return sameDay
    ? formatTime(oldest)
    : oldest.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
