// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  announceResolved,
  canAuditAnswer,
  classifyIndicator,
  isFQDN,
  isIPQuery,
  isIPv4,
  isIPv6,
} from './indicator.js'

// These are the CLIENT half of go/internal/dashboard/threatintel.go:23-87
// (isIPIndicator / isFQDN). The expectations below are hand-written from that
// Go source read line by line, not produced by running either implementation —
// including the two places the Go is deliberately LOOSE, which the client must
// match rather than "improve", or the palette would offer a dossier the server
// then refuses to recognise (and vice versa).
//
// Loose place 1: octets are only checked for "1-3 digits", never for <= 255.
// Loose place 2: IPv6 is "contains a colon, hex and colons only, length 2-45" —
// it accepts things no resolver would.

test('isIPv4 matches the Go four-1-to-3-digit-octets rule', () => {
  assert.equal(isIPv4('172.16.128.1'), true)
  assert.equal(isIPv4('10.4.0.53'), true)
  assert.equal(isIPv4('0.0.0.0'), true)
  assert.equal(isIPv4('255.255.255.255'), true)
  // Deliberately loose, exactly as Go is: no octet range check.
  assert.equal(isIPv4('999.999.999.999'), true)

  assert.equal(isIPv4(''), false)
  assert.equal(isIPv4('10.4.0'), false)
  assert.equal(isIPv4('10.4.0.53.7'), false)
  assert.equal(isIPv4('1234.1.1.1'), false)
  assert.equal(isIPv4('10.4..53'), false)
  assert.equal(isIPv4('10.4.0.5x'), false)
  assert.equal(isIPv4('app-dc1-prod.acme.corp'), false)
  assert.equal(isIPv4(null), false)
})

test('isIPv6 matches the Go loose colon-and-hex rule', () => {
  assert.equal(isIPv6('2001:db8::1'), true)
  assert.equal(isIPv6('::1'), true)
  assert.equal(isIPv6('::'), true)
  assert.equal(isIPv6('FE80::A'), true)

  assert.equal(isIPv6('2001:db8::g'), false) // g is not hex
  assert.equal(isIPv6('172.16.128.1'), false) // no colon
  assert.equal(isIPv6(':'), false) // length 1, below the Go minimum of 2
  assert.equal(isIPv6('a'.repeat(46)), false)
  assert.equal(isIPv6('2001:db8::1%eth0'), false) // zone id is not accepted
  assert.equal(isIPv6(''), false)
})

test('isFQDN matches the Go label/TLD rule', () => {
  assert.equal(isFQDN('app-dc1-prod.acme.corp'), true)
  assert.equal(isFQDN('acme.corp'), true)
  assert.equal(isFQDN('ns1.demo.infoblox.internal'), true)
  assert.equal(isFQDN('_dmarc.acme.corp'), true) // underscore label is allowed
  assert.equal(isFQDN('53.0.4.10.in-addr.arpa'), true)

  assert.equal(isFQDN('corp'), false) // one label
  assert.equal(isFQDN('172.16.128.1'), false) // numeric TLD
  assert.equal(isFQDN('acme.c'), false) // TLD shorter than 2
  assert.equal(isFQDN('acme.c0rp'), false) // TLD must be alphabetic
  assert.equal(isFQDN('-lead.acme.corp'), false) // hyphen at label start
  assert.equal(isFQDN('trail-.acme.corp'), false) // hyphen at label end
  assert.equal(isFQDN('a..b.corp'), false) // empty label
  assert.equal(isFQDN('app_dc1 prod.acme.corp'), false) // space
  assert.equal(isFQDN(''), false)
  assert.equal(isFQDN('a'.repeat(64) + '.corp'), false) // label over 63
})

// The trailing dot is how DNS actually stores a name (absolute_name_spec on the
// live tenant is "app-dc1-prod.acme.corp."), so a user pasting one out of a
// record view must still get a dossier offer. Go's isFQDN rejects it — the
// final label after the split is empty — so the client strips one trailing dot
// before classifying, and that strip is asserted here and nowhere else.
test('classifyIndicator names the kind the query bar prints', () => {
  assert.deepEqual(classifyIndicator('172.16.128.1'), { kind: 'ipv4', label: 'IPv4 address' })
  assert.deepEqual(classifyIndicator('  172.16.128.1  '), { kind: 'ipv4', label: 'IPv4 address' })
  assert.deepEqual(classifyIndicator('2001:db8::1'), { kind: 'ipv6', label: 'IPv6 address' })
  assert.deepEqual(classifyIndicator('app-dc1-prod.acme.corp'), { kind: 'fqdn', label: 'Hostname' })
  assert.deepEqual(classifyIndicator('app-dc1-prod.acme.corp.'), { kind: 'fqdn', label: 'Hostname' })

  // Everything the palette must keep treating as a tab-name query.
  assert.equal(classifyIndicator('overview'), null)
  assert.equal(classifyIndicator('dns'), null)
  assert.equal(classifyIndicator('Self-Service'), null)
  assert.equal(classifyIndicator(''), null)
  assert.equal(classifyIndicator('   '), null)
  assert.equal(classifyIndicator(undefined), null)
})

// The one caller is the dossier page's IPAM section. /api/search/ipam filters
// on address=="<q>", so the question is only meaningful for an address — asked
// about a hostname the live tenant answered HTTP 500 on 2026-08-06, and the
// page painted "Unavailable", which is a lie about a healthy system. Every
// expectation below is written from that rule, not from running the function.
test('isIPQuery is true only for the shapes IPAM can be asked about', () => {
  assert.equal(isIPQuery('172.16.128.1'), true)
  assert.equal(isIPQuery('  172.16.128.1  '), true)
  assert.equal(isIPQuery('10.4.0.53'), true)
  assert.equal(isIPQuery('2001:db8::1'), true)
  assert.equal(isIPQuery('::1'), true)

  // A hostname is the measured 500. A trailing-dot hostname is the same
  // hostname, and must not sneak through as "not an FQDN, so maybe an IP".
  assert.equal(isIPQuery('app-dc1-prod.acme.corp'), false)
  assert.equal(isIPQuery('app-dc1-prod.acme.corp.'), false)
  // Free text is not an address either, so IPAM cannot be asked about it.
  assert.equal(isIPQuery('debug-vpcflow'), false)
  assert.equal(isIPQuery('10.4.0'), false)
  assert.equal(isIPQuery(''), false)
  assert.equal(isIPQuery('   '), false)
  assert.equal(isIPQuery(undefined), false)
  assert.equal(isIPQuery(null), false)
})

// The audit gate. Read off go/internal/dashboard/csp.go:824, which is the whole
// filter the route ever builds from q:
//
//     clauses = append(clauses, "(user_name~"+rest.Lit(q)+" or resource_type~"+rest.Lit(q)+")")
//
// user_name is WHO made the change; resource_type is WHAT KIND of object it
// was ("auth_zone", "ip_space"). Neither field carries the changed object's own
// name or address, so no address and no hostname can match either side — and a
// free-text query that DID match resource_type would return "every change of
// that type", which is not the question the row asks. There is therefore no
// query shape for which this row can answer "what changed about this thing",
// which is why the expectations below are false for every shape rather than
// false for some of them.
test('canAuditAnswer is false for every query shape — the filter never sees the object', () => {
  assert.equal(canAuditAnswer('172.16.128.1'), false)
  assert.equal(canAuditAnswer('10.4.12.7'), false)
  assert.equal(canAuditAnswer('2001:db8::1'), false)
  assert.equal(canAuditAnswer('app-dc1-prod.acme.corp'), false)
  assert.equal(canAuditAnswer('app-dc1-prod.acme.corp.'), false)
  // Free text is not an exception: matching resource_type~"auth_zone" answers a
  // different question than the one the row prints.
  assert.equal(canAuditAnswer('auth_zone'), false)
  assert.equal(canAuditAnswer('debug-vpcflow'), false)
  assert.equal(canAuditAnswer(''), false)
  assert.equal(canAuditAnswer(undefined), false)
  assert.equal(canAuditAnswer(null), false)
})

// The sentence the page's live region speaks. Every expected string below is
// typed out by hand from the wording rules, not produced by calling the
// function — the point of the test is that the wording cannot drift silently,
// so a recomputed expectation would prove nothing.
test('announceResolved names each settled section and how many are left', () => {
  assert.equal(
    announceResolved([{ label: 'Assets', state: 'ok' }], 4),
    'Assets: loaded. 4 sources still loading.',
  )
  assert.equal(
    announceResolved(
      [
        { label: 'DNS records', state: 'none' },
        { label: 'Recent changes', state: 'na' },
      ],
      1,
    ),
    'DNS records: nothing found. Recent changes: not applicable. 1 source still loading.',
  )
  assert.equal(
    announceResolved([{ label: 'Threat intel', state: 'error' }], 0),
    'Threat intel: could not be read. All sources have answered.',
  )
  assert.equal(
    announceResolved([{ label: 'DNS records', state: 'unsupported' }], 0),
    'DNS records: could not be asked. All sources have answered.',
  )
})

// Nothing to announce must produce NO message, not an empty-sounding one: an
// aria-live region that is handed " . All sources have answered." for an empty
// batch would speak a sentence about nothing.
test('announceResolved says nothing when no section has settled', () => {
  assert.equal(announceResolved([], 5), '')
  assert.equal(announceResolved([{ label: 'Assets', state: 'loading' }], 5), '')
  assert.equal(announceResolved(null, 5), '')
})
