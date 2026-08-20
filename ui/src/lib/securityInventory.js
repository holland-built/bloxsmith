/**
 * One row of the Security Inventory panel, from the /api/hub/domains payload.
 *
 * Lives in lib/ rather than beside the panel for two reasons: it is the part
 * that decides what number a reader sees, so it is the part worth unit-testing;
 * and Security.jsx exporting a non-component trips the react/only-export-components
 * rule that ui/.oxlintrc.json deliberately leaves ON for that file.
 */

// The value and the note for one section, from a payload whose sections are
// deliberately NOT all the same shape: five are arrays, roaming_endpoints is an
// object carrying its own authoritative `total` and a by_status breakdown.
// Reducing that object to a length would print 0 for nine endpoints.
export function inventoryRow(section, body) {
  const availability = body?.availability?.[section]
  if (availability === 'error') return { value: null, note: 'unavailable' }

  const raw = body?.[section]
  if (section === 'roaming_endpoints') {
    const total = Number.isFinite(raw?.total) ? raw.total : null
    if (total === null) return { value: null, note: 'unavailable' }
    const byStatus = raw?.by_status ?? {}
    const states = Object.keys(byStatus)
    // Nine endpoints that all report "unknown" is not nine healthy endpoints.
    // A bare 9 beside the other rows reads as coverage; this says what it is.
    const allUnknown = states.length > 0 && states.every((k) => k === 'unknown')
    return { value: total, note: allUnknown ? 'status unknown' : null }
  }

  if (!Array.isArray(raw)) return { value: null, note: 'unavailable' }
  // Empty AND ok is a real answer — this tenant genuinely has no anycast
  // members — and it must not look like the failed read above. Zero with a
  // reason, never zero on its own.
  if (raw.length === 0) return { value: 0, note: 'none configured' }
  return { value: raw.length, note: null }
}
