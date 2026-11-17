// How much of a list the item page has, from the paging facts /api/item
// sends with each page (go/internal/server/search.go searchFetch): `total`
// when Infoblox counted the matches, otherwise `truncated` when the page came
// back full. A cut-off list must never read as the whole list.
//
// body: the LAST page loaded. shown: how many rows are on screen.
export function pageState(body, shown) {
  const total = typeof body?.total === 'number' ? body.total : null
  if (total != null) {
    const more = shown < total
    return { total, more, count: more ? `${shown} of ${total}` : String(total) }
  }
  const more = body?.truncated === true
  return { total: null, more, count: more ? `${shown} so far, more to load` : String(shown) }
}
