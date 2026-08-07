// Is this string an IP address or a hostname? — the client half of
// go/internal/dashboard/threatintel.go:23-87 (isIPIndicator / isFQDN).
//
// WHY THIS IS A PORT AND NOT AN IMPROVEMENT. The palette uses these to decide
// whether to offer "search the estate for <q>", and the server uses the Go
// originals to decide what a dossier query means. If the two disagree, the
// palette either offers a search the server will not recognise or withholds one
// it would have answered — so the two known-loose spots in the Go are copied
// deliberately, warts included:
//
//   - an IPv4 octet is checked for "1-3 digits" and NEVER for <= 255, so
//     999.999.999.999 is an "IPv4 address" here;
//   - IPv6 is "has a colon, holds only hex digits and colons, 2-45 chars",
//     which accepts strings no resolver would.
//
// Both are safe in this direction: the worst case is offering a dossier for a
// string the tenant holds nothing about, and the page's own empty state says so
// honestly. Tightening either one without tightening the Go would be the
// dangerous direction.
//
// It lives in lib/ rather than inside Palette.jsx so the rules above can be
// asserted by node --test with no browser — see indicator.test.js.

function isDigits(s) {
  for (const ch of s) {
    if (ch < '0' || ch > '9') return false
  }
  return true
}

/** Four dot-separated groups of 1-3 digits. No range check — see the header. */
export function isIPv4(q) {
  if (typeof q !== 'string' || q === '') return false
  const parts = q.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => p !== '' && p.length <= 3 && isDigits(p))
}

/** Loose IPv6: must contain a colon, hex digits and colons only, length 2-45. */
export function isIPv6(q) {
  if (typeof q !== 'string') return false
  if (!q.includes(':') || q.length < 2 || q.length > 45) return false
  return /^[0-9a-fA-F:]+$/.test(q)
}

/**
 * Two or more labels; an alphabetic TLD of 2-63 chars; every other label 1-63
 * chars of letters, digits, underscore, or an interior hyphen.
 */
export function isFQDN(q) {
  if (typeof q !== 'string' || q.length < 1 || q.length > 253) return false
  const labels = q.split('.')
  if (labels.length < 2) return false

  const tld = labels[labels.length - 1]
  if (tld.length < 2 || tld.length > 63) return false
  if (!/^[a-zA-Z]+$/.test(tld)) return false

  return labels.slice(0, -1).every((lb) => {
    if (lb.length < 1 || lb.length > 63) return false
    for (let i = 0; i < lb.length; i++) {
      const c = lb[i]
      const ok =
        /[a-zA-Z0-9_]/.test(c) || (c === '-' && i > 0 && i < lb.length - 1)
      if (!ok) return false
    }
    return true
  })
}

/**
 * What kind of thing did the user type, and what should the query bar call it?
 * Returns null for anything that is not an indicator — which is what keeps the
 * palette's tab-jumping untouched, since every tab name lands here as null.
 *
 * The one place this is stricter than a straight port: a single trailing dot is
 * stripped first. DNS stores names WITH the root dot (the live tenant's
 * absolute_name_spec reads "app-dc1-prod.acme.corp."), so a name pasted out of a
 * record view has one; Go's isFQDN would see an empty final label and reject it.
 * The server's own search handler already appends the dot when it is missing
 * (server/search.go), so stripping it here only ever widens what we recognise —
 * it can never send a query the server cannot handle.
 */
export function classifyIndicator(input) {
  const q = typeof input === 'string' ? input.trim() : ''
  if (!q) return null
  if (isIPv4(q)) return { kind: 'ipv4', label: 'IPv4 address' }
  if (isIPv6(q)) return { kind: 'ipv6', label: 'IPv6 address' }
  const bare = q.endsWith('.') ? q.slice(0, -1) : q
  if (isFQDN(bare)) return { kind: 'fqdn', label: 'Hostname' }
  return null
}

/**
 * Can a source that searches BY IP ADDRESS be asked about this query at all?
 *
 * This is a question about the query's shape, which is why it lives beside the
 * classifier rather than inside the page: /api/search/ipam sends the query
 * upstream as `address=="<q>"`, so for a hostname the filter is not merely
 * fruitless, it is meaningless — the live tenant answers HTTP 500 and the
 * dossier row then reports "Unavailable" about a system that is working. The
 * page uses this to skip that request entirely; the honest state is "this
 * question does not apply here", and the only way to earn it is not to ask.
 *
 * It answers false for free text as well as for hostnames, for the same
 * reason: neither is an address.
 */
export function isIPQuery(input) {
  const kind = classifyIndicator(input)?.kind
  return kind === 'ipv4' || kind === 'ipv6'
}

/**
 * Can the audit log answer "what changed about THIS thing"? No — for any query,
 * which is why this takes an argument it does not read.
 *
 * The whole of what /api/csp-audit builds from q is one clause
 * (go/internal/dashboard/csp.go:824):
 *
 *     clauses = append(clauses, "(user_name~"+rest.Lit(q)+" or resource_type~"+rest.Lit(q)+")")
 *
 * user_name is WHO made the change; resource_type is WHAT KIND of object it was
 * ("auth_zone", "ip_space"). The changed object's own name or address appears in
 * neither field, so for an address and for a hostname alike both sides of the
 * `or` are dead — and the route answers {rows:[], status:"ok"}, which the
 * dossier page then read as a genuine zero and printed as "no change touching
 * this in the audit window — we asked, and the log holds none". That is a proven
 * negative for a question the endpoint cannot ask, and it fired on every
 * indicator search rather than on any failure.
 *
 * Free text is not an exception and that is the reason this is a flat false
 * rather than a shape gate like isIPQuery: a query that DID match
 * resource_type~"auth_zone" would return every change of that kind, which
 * answers a different question than the one the row prints. There is no query
 * shape this row genuinely serves, so the honest gate is "never ask".
 *
 * It keeps the predicate signature so the page can wire it as `applies` beside
 * isIPQuery, and so this file — not a component — is where the claim about the
 * Go filter lives and is asserted.
 */
export function canAuditAnswer() {
  return false
}

// ---------------------------------------------------------------------------
// what the dossier page says out loud
// ---------------------------------------------------------------------------
//
// The page's five sections settle at wildly different speeds, so its aria-live
// region needs one sentence per BATCH of sections rather than one per section.
// Building that sentence is a pure decision, so it lives here beside the other
// one the page defers to, where node --test can assert the exact wording
// without a browser.

// The state names are DossierPage's five settled outcomes. Each word says what
// happened to the question, never what is true of the estate: "nothing found"
// is a real zero from a source that was asked, and the two unknown states are
// worded so neither can be heard as one.
const SETTLED_WORD = {
  ok: 'loaded',
  none: 'nothing found',
  na: 'not applicable',
  unsupported: 'could not be asked',
  error: 'could not be read',
}

/**
 * One sentence for a batch of sections that settled together.
 *
 * items: [{ label, state }] in the order they appear in the ledger.
 * remaining: how many sections are still loading after this batch.
 *
 * An empty batch produces an empty string rather than a tail on its own — an
 * aria-live region handed "All sources have answered." for a batch of nothing
 * would speak a sentence about nothing.
 */
export function announceResolved(items, remaining) {
  const parts = (Array.isArray(items) ? items : [])
    .filter((it) => it && SETTLED_WORD[it.state])
    .map((it) => `${it.label}: ${SETTLED_WORD[it.state]}.`)
  if (!parts.length) return ''
  const tail =
    remaining > 0
      ? `${remaining} ${remaining === 1 ? 'source' : 'sources'} still loading.`
      : 'All sources have answered.'
  return `${parts.join(' ')} ${tail}`
}
