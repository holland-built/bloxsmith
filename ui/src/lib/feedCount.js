/**
 * The number a FeedCard puts in its header.
 *
 * It used to be `rows.length`, unconditionally, and that is what made the Host
 * Health card read "500" for an estate the server had already measured at 532:
 * the server asked for 500 rows, got 500, and the card printed the request
 * limit dressed up as a fact about the tenant.
 *
 * Now the server sends `total_available` when it knows the list it returned is
 * not the whole set, and this is where that becomes visible. A payload with no
 * `truncated` flag is unchanged, byte for byte — a feed that never learned its
 * total must not start implying it has one.
 *
 * @param {object|undefined} data the feed payload
 * @param {number} rowCount rows actually on screen
 * @returns {string|null} the header text, or null when there is nothing to show
 */
export function feedCountLabel(data, rowCount) {
  if (!Number.isFinite(rowCount) || rowCount <= 0) return null
  const total = data?.total_available
  // Both conditions, not either: the flag is the server's claim, and the
  // comparison is the check that the claim is coherent with what arrived. A
  // total that is missing, unparseable, or not actually larger prints the plain
  // count rather than a confusing "500 of 500".
  if (data?.truncated === true && Number.isFinite(total) && total > rowCount) {
    return `${rowCount.toLocaleString()} of ${total.toLocaleString()}`
  }
  return rowCount.toLocaleString()
}

/**
 * The tooltip that goes with it. Only present when the count is qualified —
 * a plain count needs no explanation, and a tooltip on every card is noise.
 */
export function feedCountTitle(data, rowCount) {
  if (feedCountLabel(data, rowCount)?.includes(' of ') && typeof data?.reason === 'string') {
    return data.reason
  }
  return undefined
}
