// Plain words for what the audit records say (GUI audit C8, 2026-11-25).
//
// The Infoblox Portal names its actions UPDATE/DELETE and its objects by API
// name (dnsrecord, auth_zone, addressservice). Bloxsmith's own log records a
// refused request as "POST /api/edit/dnsrecord" with a reason code. The owner
// reads none of those, so Audit and Changes both show these words instead and
// keep the record itself in the cell's title.

const ACTION = { create: 'Created', update: 'Changed', delete: 'Deleted' }

/** "UPDATE" -> "Changed". A verb not listed here is shown in sentence case. */
export function actionWord(action) {
  const s = String(action ?? '').trim()
  if (!s) return ''
  const low = s.toLowerCase()
  return ACTION[low] ?? low[0].toUpperCase() + low.slice(1)
}

/**
 * "success" -> "Worked", "failed: denied" -> "Refused", any other failure ->
 * "Failed" (GUI audit R2-C4). The record's own text stays in the cell's title.
 */
export function resultWord(result) {
  const low = String(result ?? '').trim().toLowerCase()
  if (!low) return ''
  if (low === 'success' || low === 'succeeded' || low === 'ok') return 'Worked'
  if (/denied|refused|forbidden|unauthori[sz]ed/.test(low)) return 'Refused'
  if (/fail|error/.test(low)) return 'Failed'
  return low[0].toUpperCase() + low.slice(1)
}

// The server's account classes (auditClass in go/internal/dashboard/norm.go).
const WHO_KIND = { service: 'automated account' }

/** "service" -> "automated account"; person, device and the rest stay as they are. */
export function whoKindWord(kind) {
  const low = String(kind ?? '').trim().toLowerCase()
  return WHO_KIND[low] ?? low
}

// Portal API names and the app's own route names, one map for both.
const RESOURCE = {
  dnsrecord: 'DNS record',
  dns_record: 'DNS record',
  auth_zone: 'DNS zone',
  dns_zone: 'DNS zone',
  addressservice: 'IP address',
  address: 'IP address',
  subnetservice: 'Subnet',
  subnet: 'Subnet',
  address_block: 'Address block',
  block: 'Address block',
  host: 'Host',
  site: 'Site',
}

/**
 * "dnsrecord" -> "DNS record". An unknown API name loses its underscores; any
 * other text (a path, a domain name) is shown as it came.
 */
export function resourceWord(resource) {
  const s = String(resource ?? '').trim()
  if (!s) return ''
  if (RESOURCE[s.toLowerCase()]) return RESOURCE[s.toLowerCase()]
  if (!/^[a-z_]+$/.test(s)) return s
  const words = s.replace(/[_-]+/g, ' ').trim()
  return words[0].toUpperCase() + words.slice(1)
}

const REASON = {
  'tenant-read-only': 'changes are turned off',
  'tenant-unknown': "couldn't tell which account it would change",
}

// What each write route does, from its registration in go/internal/server
// (edit.go, writelock.go). `verb` is the verb, or a function of the method
// when one path serves several (the editor: POST creates, PATCH changes,
// DELETE deletes). `what` names the object when the path itself does not.
// A route not listed here is shown as it was sent, never guessed at.
const EDIT_VERB = { POST: 'create', PATCH: 'change', DELETE: 'delete' }
const ROUTES = [
  // No method is recorded on a role refusal, so "edit" is all that is known.
  { prefix: '/api/edit/', verb: (m) => EDIT_VERB[m] ?? 'edit', named: true },
  // The subnet job's stream names no object in its path (provisionSubnetStream).
  { prefix: '/api/provision/stream', verb: () => 'create', what: 'subnet' },
  { prefix: '/api/provision/', verb: () => 'create', named: true },
  { prefix: '/api/teardown/', verb: () => 'remove', named: true },
  { prefix: '/api/selfservice/allocate', verb: () => 'reserve', what: 'address' },
  { prefix: '/api/ipam/addresses/', verb: () => 'give back', what: 'address' },
  { prefix: '/api/dns/records', verb: (m) => EDIT_VERB[m] ?? 'edit', what: 'dnsrecord' },
  { prefix: '/api/block-domain', verb: () => 'block', what: 'domain' },
  { prefix: '/api/unblock-domain', verb: () => 'unblock', what: 'domain' },
  { prefix: '/api/lists/apply', verb: () => 'change', what: 'site list' },
  { prefix: '/api/lists/proposal/apply', verb: () => 'change', what: 'site list' },
  { prefix: '/api/update/apply', sentence: 'update the app' },
  { prefix: '/api/alerts/snooze', sentence: 'snooze an alert' },
]
const MORE = { domain: 'Domain', 'site list': 'Site list', demo: 'Demo server', 'seed-demo': 'Demo data', dhcp_range: 'DHCP range' }

const AN = /^[aeiou]/i
const cap = (s) => s[0].toUpperCase() + s.slice(1)

// "Subnet" -> "a subnet", but "DNS record" keeps its capitals.
function withArticle(word) {
  const name = /^.[a-z]/.test(word) ? word[0].toLowerCase() + word.slice(1) : word
  return `${AN.test(name) ? 'an' : 'a'} ${name}`
}

/**
 * A logged request as a sentence: "Tried to change a DNS record; changes are
 * turned off". Facts the sentence cannot say follow it: the real name of an
 * object the word map does not know, and the role a refusal needed. Null when
 * the detail holds no request, so the caller keeps its own text.
 */
export function plainRequest(detail) {
  if (!detail || typeof detail !== 'object' || !detail.path) return null
  const path = String(detail.path)
  const method = String(detail.method ?? '').toUpperCase()
  const route = ROUTES.find((r) => path.startsWith(r.prefix))
  const facts = []
  let action = null
  if (route?.sentence) action = route.sentence
  else if (route) {
    // The editor, provision and teardown name the object in the path.
    const raw = route.named ? path.slice(route.prefix.length).split('/')[0] : route.what
    const known = raw && (RESOURCE[raw.toLowerCase()] || MORE[raw])
    if (raw && !known) facts.push(`Object: ${raw}`)
    action = `${route.verb(method)} ${known ? withArticle(known) : 'something'}`
  }
  if (detail.required) facts.push(`Needs the ${cap(String(detail.required))} role`)
  const why = detail.reason ? REASON[detail.reason] ?? String(detail.reason).replace(/-/g, ' ') : null
  const asSent = [method, path].filter(Boolean).join(' ')
  const head = action
    ? why ? `Tried to ${action}; ${why}` : cap(action)
    : why ? `Tried ${asSent}; ${why}` : `Request: ${asSent}`
  return [head, ...facts].join(' · ')
}
