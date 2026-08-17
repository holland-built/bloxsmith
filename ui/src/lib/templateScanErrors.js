/**
 * The entries in the template list that are not templates at all — files and
 * directories the server could not read, parse, or search.
 *
 * The server used to drop these silently, so the list was simply shorter than
 * the directory and an operator had nothing to act on (#134). It now returns
 * them as rows carrying `kind: 'scan-error'`. They still show in the dropdown
 * as `(invalid)` and stay disabled, which is right — you cannot build from
 * them — but "(invalid)" alone cannot tell a typo in the YAML from a permission
 * bit, and those need completely different fixes.
 *
 * A scan error is NOT the same as a template that failed schema validation.
 * The second one parsed fine and has a fixable field; the first one could not
 * be read at all. Only rows the server marked `scan-error` appear here.
 *
 * @param {unknown} templates the /api/templates payload
 * @returns {Array<{key: string, name: string, reason: string}>}
 */
export function templateScanErrors(templates) {
  if (!Array.isArray(templates)) return []
  return templates
    .filter((t) => t && typeof t === 'object' && t.kind === 'scan-error')
    .map((t, i) => ({
      key: `${text(t.name) || 'entry'}-${i}`,
      name: text(t.name) || 'an unnamed entry',
      // An older server sends no `error`. Saying so beats rendering a blank
      // line that looks like the reason is nothing.
      reason: text(t.error) || 'no reason given',
    }))
}

function text(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
