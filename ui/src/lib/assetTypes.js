// The Assets page's numbers, worked out apart from the page so they can be
// tested on their own: the asset types ranked largest first with each one's
// share, the unclassified count, and "Last seen" as an age.
//
// The type that discovery could not name comes back from the cube as the
// label "Unclassified" (the same value chart_builder.go filters on).
export const UNCLASSIFIED = 'Unclassified'

// The denominator for every share on the page. The filter feed's own total
// when it has one; otherwise the sum of the type counts, which is the same
// thing on a tenant where every asset has a type label (100% filled upstream).
export function typeTotal(filters) {
  if (typeof filters?.total === 'number') return filters.total
  const types = filters?.types ?? []
  // Any type without a count leaves the total unknown: summing the rest would
  // overstate every share (one known type would read as 100%).
  if (!types.length || !types.every((t) => typeof t.count === 'number')) return null
  return types.reduce((s, t) => s + t.count, 0)
}

// A share as people say it: whole percent from 1% up, one decimal below that,
// and "<0.1%" rather than a "0.0%" that reads as none.
export function shareText(n, total) {
  if (typeof n !== 'number' || typeof total !== 'number' || total <= 0) return ''
  const p = (n / total) * 100
  if (n > 0 && p < 0.1) return '<0.1%'
  if (p < 1) return `${p.toFixed(1)}%`
  return `${Math.round(p)}%`
}

// Types largest first (ties A to Z), each with its share of the total. `top`
// rows are shown; the active filter is always among them even when it is
// smaller, so a chosen type never disappears from view. `hidden` is how many
// are left for the "more" button.
export function rankTypes(types, total, { top = 8, active = '' } = {}) {
  const all = [...(types ?? [])]
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || String(a.label).localeCompare(String(b.label)))
    .map((t) => ({ ...t, share: typeof t.count === 'number' && total > 0 ? t.count / total : null }))
  if (all.length <= top) return { shown: all, hidden: 0, all }
  const shown = all.slice(0, top)
  const act = active && !shown.some((t) => t.label === active) ? all.find((t) => t.label === active) : null
  if (act) shown.push(act)
  return { shown, hidden: all.length - shown.length, all }
}

// The unclassified count from the filter feed. 0 when the feed answered and
// had no such type; null when there is no answer to give.
export function unclassifiedCount(filters) {
  const types = filters?.types
  if (!Array.isArray(types)) return null
  const t = types.find((x) => x.label === UNCLASSIFIED)
  return t ? (typeof t.count === 'number' ? t.count : null) : 0
}

// Cube.js sends UTC with no zone ("2026-10-30T17:58:25.000"). new Date()
// reads a zoneless date-time as local time, which put Last seen hours ahead.
export function parseSeen(v) {
  if (!v) return null
  const s = String(v)
  const d = new Date(/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? `${s}Z` : s)
  return isNaN(d) ? null : d
}

// "8h ago", short enough for the column; the exact time goes in the tip.
export function seenAgo(v, now = Date.now()) {
  const d = parseSeen(v)
  if (!d) return null
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 60) return `${days}d ago`
  return d.toLocaleDateString()
}
