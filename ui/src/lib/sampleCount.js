/**
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
 * The server now sends `returned` (the rows it counted), `truncated` (whether
 * there are more), and `total` ONLY when upstream gave an authoritative figure.
 * These helpers are the single place that turns those three into words, so the
 * three panels cannot drift into describing the same payload differently.
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
  const returned = Number.isFinite(data?.returned) ? data.returned : 0
  if (!isSample(data)) return `${returned.toLocaleString()} ${noun}`

  const total = knownTotal(data)
  if (total !== null) {
    return `${returned.toLocaleString()} of ${total.toLocaleString()} ${noun}`
  }
  // Truncated with no total is the honest dead end: there ARE more, and how
  // many is not knowable from this response. "50+ events" was rejected as the
  // wording because it reads as a measured lower bound of the hour rather than
  // as a page size.
  return `${returned.toLocaleString()} ${noun} shown, total unknown`
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
  const returned = Number.isFinite(data?.returned) ? data.returned : 0
  const total = knownTotal(data)
  const of = total !== null ? ` of ${total.toLocaleString()}` : ''
  return `Counted from the ${returned.toLocaleString()}${of} ${noun} shown, not the whole window.`
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
  const returned = Number.isFinite(data?.returned) ? data.returned : 0
  const total = knownTotal(data)
  if (total !== null) return { label: totalLabel, value: total }
  // Not truncated and no total means the rows in hand ARE everything in the
  // window, so "total" is accurate without upstream having to say so.
  if (!isSample(data)) return { label: totalLabel, value: returned }
  return { label: sampleLabel, value: returned }
}
