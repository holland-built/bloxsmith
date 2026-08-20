/**
 * The "…more results not shown here" line under a dossier section.
 *
 * THE BUG THIS EXISTS FOR (issue #153). The line used to be computed entirely
 * from the rows in hand:
 *
 *   const shown = rows.slice(0, MAX_ROWS)
 *   const hidden = rows.length - shown.length
 *   // "{hidden} more results not shown here"
 *
 * which is right only while the server handed over everything it found.
 * go/internal/server/search.go caps at `searchLimit` (50) and says so: it
 * returns `{total, limit}` when upstream published an authoritative count, and
 * `{truncated, limit}` when it did not. DossierPage read neither. So a query
 * matching 500 records got 50 rows, showed 6, and stated "44 more results" —
 * a specific number, on screen, that was wrong by 450.
 *
 * NOT REPRODUCED AGAINST A LIVE TENANT, and that is stated rather than glossed:
 * both search routes match on exact name or exact address, so no probe against
 * the current tenant returned more than a handful of rows, let alone 51. What
 * was confirmed live is that the payload carries `truncated` and `limit` to the
 * browser and that the page discarded them. The wording rules below are pinned
 * by unit tests against the three payload shapes the server can actually emit.
 *
 * THE RULE: never state a number the payload does not support. When the search
 * itself was capped and nobody published a total, the honest line says there
 * are more and says why the count is unknown — it does not print the number of
 * rows that happened to arrive.
 */

const TAIL = 'this ledger shows one line per result.'

/**
 * @param {object|null|undefined} body the raw search payload
 * @param {number} rowCount rows the page received
 * @param {number} shownCount rows the page drew
 * @returns {string|null} the line, or null when there is nothing to say
 */
export function dossierMoreLine(body, rowCount, shownCount) {
  const hiddenHere = Math.max(0, rowCount - shownCount)

  // An authoritative total settles it: the hidden count is measured against
  // everything that matched, not against what fitted in one page.
  const total = body?.total
  if (Number.isFinite(total) && total > shownCount) {
    const hidden = total - shownCount
    return `${hidden.toLocaleString()} more ${hidden === 1 ? 'result' : 'results'} not shown here — ${TAIL}`
  }

  // Capped with no total. There ARE more and how many is not knowable from this
  // response, so the line says exactly that. Printing `hiddenHere` here is the
  // defect: it is a count of what arrived, dressed as a count of what matched.
  if (body?.truncated === true) {
    const limit = Number.isFinite(body?.limit) ? body.limit : null
    const cap = limit === null ? 'the search was capped' : `the search stopped at the first ${limit.toLocaleString()}`
    return `More results not shown here — ${cap}, so the number left over is unknown.`
  }

  // Nothing was capped, so the rows in hand are everything that matched and the
  // original arithmetic is correct.
  if (hiddenHere > 0) {
    return `${hiddenHere.toLocaleString()} more ${hiddenHere === 1 ? 'result' : 'results'} not shown here — ${TAIL}`
  }
  return null
}
