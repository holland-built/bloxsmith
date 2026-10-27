import LZString from 'lz-string'

// "Open in Infoblox" for Build a chart. Its own module, not in chartBuilder.js,
// so lz-string loads with the Build a chart tab only: chartBuilder.js is also
// in the saved-chart code every page loads, and tests/bundle-budget.spec.ts
// caught the 1.3 KB it added to #provision.
//
// The Infoblox Portal's Asset Inventory, opened with an advanced filter. The
// portal reads `advancedFilterValue` as the filter text, JSON-quoted and then
// lz-string compressed, and fills it in on a full page load; the reader still
// presses Apply there. Checked by hand on 2026-10-27 for every field the
// server lists under a split's `portal`.
const PORTAL_ASSETS = '/#/workspace/assets/details/managed-assets?hideBreadcrumbs=true'

function portalTerm(opts, splitId, value) {
  const p = opts.splits.find((x) => x.id === splitId)?.portal
  // A blank value is "Not reported" here, and the portal has no tested way to
  // ask for a blank, so it gets no link rather than a link to nothing.
  if (!p || value == null || String(value) === '') return null
  const v = JSON.stringify(String(value))
  return p.op === 'CONTAINS' ? `${p.field} CONTAINS ${v}` : `${p.field} IN [${v}]`
}

/**
 * The portal link for an asset chart: its Only show filter, plus one bar's
 * value when `value` is given. Null when the chart is not an asset count, the
 * server named no portal, or a part of the filter has no portal equivalent
 * (an "is not" filter, a split with no checked portal field, a blank value):
 * a link that silently drops part of the chart would show different assets.
 */
export function portalLink(opts, picks, value) {
  const base = typeof opts?.portal === 'string' && /^https:\/\/[^/?#]+$/.test(opts.portal) ? opts.portal : null
  if (!base || picks.count !== 'assets') return null
  const terms = []
  if (picks.only && picks.value) {
    if (picks.is !== 'is') return null
    const t = portalTerm(opts, picks.only, picks.value)
    if (!t) return null
    terms.push(t)
  }
  if (value !== undefined) {
    const t = portalTerm(opts, picks.split, value)
    if (!t) return null
    terms.push(t)
  }
  const url = base + PORTAL_ASSETS
  if (!terms.length) return url
  return `${url}&isAdvanced=true&advancedFilterValue=${LZString.compressToEncodedURIComponent(JSON.stringify(terms.join(' AND ')))}`
}
