/**
 * Telling "nobody measured this" apart from "this is zero".
 *
 * WHY THIS FILE EXISTS. Until 2026-08-20 `num`, `freeOf` and `DASH` were
 * defined twice, byte for byte, in ui/src/tabs/Overview.jsx and
 * ui/src/tabs/Network.jsx — comments included — and `DASH` a third time in
 * ui/src/components/DossierPage.jsx. What was being duplicated is not a
 * convenience wrapper, it is a correctness rule: the comment on `num` is the
 * only written record of why a null must not become a 0. Two copies means a fix
 * to one leaves the other still turning "nobody measured this subnet" into
 * "this subnet is empty", which is the exact class of bug this repo keeps
 * filing. `utilStatus` already lives once, in components/ui.jsx, and both tabs
 * import it; this is the same move for the helpers beside it.
 */

/**
 * A number the backend actually measured, or null when it did not.
 *
 * go/internal/dashboard/norm.go emits JSON null — not 0 — for util/total/used
 * on a subnet whose upstream row reports no total. `Number(x) || 0` turns that
 * null into a healthy-looking 0%, i.e. "this subnet is empty", which is
 * precisely the claim we cannot make. Everything downstream carries the null
 * instead and renders it as —. Checked against the live tenant: every subnet
 * there currently reports a total, so this is a guard, not a live symptom —
 * the 295 rows sitting at 0% do report total=0 and are a real measurement.
 */
export function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * total - used, or null when either side is unknown: an unknown minus a known
 * is not a number of free addresses.
 */
export function freeOf(s) {
  const total = num(s.total)
  const used = num(s.used)
  return total === null || used === null ? null : total - used
}

/** A count we could not fetch is not a count of zero. */
export const DASH = '—'

/**
 * Compare two possibly-null numbers, unknown always LAST in the direction on
 * screen: 0 would rank an unmeasured subnet as the emptiest one, and the top
 * of a worst-first sort would rank it as the most exhausted. Neither is known.
 */
export function cmpMaybe(av, bv, dir) {
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  return dir === 'asc' ? av - bv : bv - av
}
