/**
 * The DHCP ranges a site provision decided not to create.
 *
 * The site Result card counts `dhcp_ranges` and nothing else, so a range the
 * engine refused to place used to leave that count one lower and say nothing —
 * indistinguishable from a subnet that never asked for DHCP. The engine now
 * records each refusal in `dhcp_ranges_skipped` (#131, #132); this is what turns
 * that list into rows to render.
 *
 * A SKIP IS SHOWN IN PREVIEW TOO, which is why this is not folded into the
 * Result card: that card only renders once `status === 'applied'`, and a preview
 * is the run where learning the range cannot be placed still costs nothing.
 *
 * Rows with no name are kept, not dropped. "A range on some subnet was skipped"
 * is a smaller answer than the operator wants but a true one; dropping the row
 * would report that nothing was skipped.
 *
 * @param {object|undefined} result the site provision result map
 * @returns {Array<{key: string, name: string, subnet: string, range: string, reason: string}>}
 */
export function dhcpSkips(result) {
  const rows = result?.dhcp_ranges_skipped
  if (!Array.isArray(rows)) return []
  return rows.filter((r) => r && typeof r === 'object').map((r, i) => {
    const start = str(r.start)
    const end = str(r.end)
    return {
      key: `${str(r.name) || 'range'}-${i}`,
      name: str(r.name) || 'DHCP range',
      subnet: str(r.subnet),
      // Empty when the engine had no address to compute — an unparseable or
      // non-IPv4 subnet. Printing "–" there would look like a range of nothing;
      // printing nothing lets the reason carry it.
      range: start && end ? `${start}–${end}` : '',
      reason: str(r.reason) || 'no reason given',
    }
  })
}

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
