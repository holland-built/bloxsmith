// Provider and Vendor are two cube dimensions (providers_label, vendor) that
// hold the same string on every row of some tenants. Rendering them as two
// identical columns wastes a column of a table that is already the widest
// thing on the page, so they collapse into one "Provider / Vendor" column when
// they agree.
//
// WHY THIS IS A REDUCER AND NOT `rows.every(...)` AT THE CALL SITE. The Assets
// table is paged 50 rows at a time, and the merge condition is a property of
// the page, not of the tenant. Evaluated per page it would collapse the header
// on page 4 and expand it again on page 5 — a table whose column count changes
// while you page through it, which is the exact instability DataTable's `keep`
// policy exists to prevent. So the decision is made once per search/type/sort
// state and carried across that state's pages.
//
// AND IT IS ONE-WAY-LOSABLE. Holding the first page's answer forever would be
// worse than recomputing: page 1 agreeing does not mean page 9 does, and a
// merged column on a page where the two values differ hides one of them. So a
// page that proves them different unmerges, permanently for that filter state
// — merging can be lost mid-browse but never won back. Changing the filter
// starts a fresh decision.

// Two blanks are the same value and merge honestly; a blank against a real
// provider is a genuine difference. `?? ''` (not `|| ''`) so a literal 0 or
// false from a future dimension is compared as itself.
function sameOnRow(r) {
  return (r?.provider ?? '') === (r?.vendor ?? '')
}

// The identity of a decision: everything that changes WHICH rows come back,
// except the page — paging is what the decision is held across. Length-
// prefixed rather than concatenated, so q='ab',type='' and q='a',type='b'
// cannot produce the same key and inherit each other's decision.
export function mergeStateKey({ q = '', type = '', sort } = {}) {
  const parts = [String(q ?? ''), String(type ?? ''), String(sort?.key ?? ''), String(sort?.dir ?? '')]
  return parts.map((s) => `${s.length}:${s}`).join('|')
}

/**
 * Fold one page of rows into the merge decision.
 *
 * @param {{stateKey: string, decided: boolean, merged: boolean, ignoreRows: Array|null}|null} prev
 * @param {string} stateKey  from mergeStateKey() — a new one resets everything
 * @param {Array<object>} rows  the page currently rendered
 * @returns the next decision; the SAME object when nothing changed
 */
export function nextMergeState(prev, stateKey, rows) {
  // A filter change reaches this function BEFORE its rows do. useApi holds the
  // previous payload on screen for the whole request, so the render in which
  // stateKey changes still carries the OLD filter's page — and folding that
  // would let rows the new filter never contained lose the merge for it.
  // Measured: the unfiltered page has 2 mismatched rows in 50, which is exactly
  // why type=Storage Volume (44 rows, every one of them equal) rendered two
  // columns before this guard existed. `lastRows` is the discriminator: a
  // payload that has landed is always a new array, and the array still on
  // screen is the same one by identity.
  const base =
    prev && prev.stateKey === stateKey
      ? prev
      : { stateKey, decided: false, merged: false, lastRows: prev ? prev.lastRows : null }

  // The same array carries nothing it has not already contributed.
  if (rows === base.lastRows) return base

  // Already lost for this filter state. Nothing a later page wins back.
  if (base.decided && !base.merged) return { ...base, lastRows: rows }

  // An empty page has shown neither agreement nor disagreement, so it decides
  // nothing — it must not burn the decision before the first rows arrive.
  if (!Array.isArray(rows) || rows.length === 0) return { ...base, lastRows: rows }

  return { stateKey, decided: true, merged: rows.every(sameOnRow), lastRows: rows }
}
