/**
 * WHAT THIS IS: the drift-item classifier, moved out of Drift.jsx so it can be
 * tested. It is the only place in the UI that reads a drift item's MESSAGE
 * PROSE, and that prose is written in Go — go/internal/provision/drift.go's
 * DetectDrift builds every sentence it matches on.
 *
 * That makes the pill a cross-language contract with nothing on either side
 * holding it. It sat inside the page component, where `npm test` cannot reach
 * it (node --test runs plain .js with no JSX transform), so a reworded Go
 * message would have silently relabelled every row. driftStatus.test.js pins
 * the three sentences DetectDrift can produce.
 *
 * ui/src/lib/indicator.js records the same reasoning for the dossier page:
 * a classifier belongs in lib, not inside the page.
 *
 * WHAT IT RETURNS is a KIND, not a colour. Colours live with the component that
 * paints them; keeping them here is what forced this function to import from
 * a .jsx file and put it out of reach of the tests.
 *
 * @param {{message?: string}} d one entry from a /api/drift/check drifts array
 * @returns {'extra'|'changed'|'missing'}
 */
export function driftItemKind(d) {
  const m = String(d?.message || '')
  // "Subnet 'x' exists in API but is not in the template" — nothing is wrong
  // with the object, it is simply unaccounted for.
  if (/is not in the template/.test(m)) return 'extra'
  // "Tag 'Env' on subnet 'voice': expected 'prod', live value is 'dev'" — the
  // thing exists and holds something else.
  if (/live value is/.test(m)) return 'changed'
  // Everything else, including an absent or non-string message. "missing" is
  // the fallthrough because an unreadable item is not evidence that something
  // is merely different.
  return 'missing'
}
