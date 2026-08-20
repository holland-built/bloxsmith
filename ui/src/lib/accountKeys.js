/**
 * Which CSP accounts this install actually holds a key for.
 *
 * WHY THIS IS A NAME MATCH, WHICH IS WEAKER THAN IT LOOKS. Nothing in the data
 * links the two lists. `/api/accounts` returns CSP accounts as
 * `{id: "identity/accounts/<uuid>", name: "Infoblox Sales"}`, and
 * `/api/vault/status` returns saved tenants as `{id: "<vault id>", label:
 * "Infoblox Sales"}`. The vault id is the vault's own, not CSP's, and a tenant
 * record stores no account id at all — so the label is the only thing the two
 * share, and matching on it is a guess that happens to be right whenever the
 * tenant was labelled after the account it belongs to.
 *
 * That is why the answer is used ONLY to grey a row out, never to block one.
 * A greyed row is still selectable; it says "you probably have no key for this"
 * and lets the operator find out. Getting the guess wrong then costs a failed
 * switch and a message, not a lockout — which is the right way round for a link
 * this thin.
 *
 * If the vault ever starts recording the CSP account id it was issued for, throw
 * this away and compare ids.
 */

/** Trim and casefold, so "Infoblox Sales " and "infoblox sales" are one name. */
function norm(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : ''
}

/**
 * @param {Array<{label?: string}>|undefined} tenants /api/vault/status tenants
 * @returns {Set<string>} normalised labels there is a stored key for
 */
export function keyedAccountNames(tenants) {
  const out = new Set()
  for (const t of tenants ?? []) {
    const n = norm(t?.label)
    if (n) out.add(n)
  }
  return out
}

/**
 * @param {{name?: string}} account one /api/accounts entry
 * @param {Set<string>} keyed from keyedAccountNames
 */
export function accountHasKey(account, keyed) {
  const n = norm(account?.name)
  // An account with no name cannot be matched, and saying "no key" about it
  // would be a claim. Treated as keyed so it renders normally: the honest
  // default for "cannot tell" is to leave it alone.
  if (!n) return true
  return keyed.has(n)
}
