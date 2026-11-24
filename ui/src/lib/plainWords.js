// The server names incidents and zone problems in short engineering words
// ("dns-ttl-anomaly", "High Neg-TTL"). The owner asked for everyday words on
// screen, so the screens say them through here. The server's own words stay
// the data (filters, acks and saved state still match on them), only what is
// shown changes, and one place keeps every tab saying the same thing.

const CATEGORY = {
  'subnet-utilization': 'Subnet filling up',
  'dns-ttl-anomaly': 'DNS zone timing',
  'dhcp-expired-lease': 'Expired address lease',
  'dnssec-unsigned': 'Zones not signed',
}

const ISSUE = {
  'High Neg-TTL': 'remembers "not found" too long',
  'TTL Too Low': 'cache time too short',
  'TTL Too High': 'cache time too long',
}

/**
 * A host-status bucket as shown on screen. The "Offline" bucket holds hosts
 * Infoblox reports as offline, down OR error, so it is shown as "Not online"
 * rather than claim which. The bucket name itself stays the key (URLs, colours).
 */
export function bucketWord(name) {
  return name === 'Offline' ? 'Not online' : name
}

/** A category id in words: the known ones by name, any other one de-dashed. */
export function categoryWord(id) {
  const s = String(id ?? '')
  if (CATEGORY[s]) return CATEGORY[s]
  const words = s.replace(/[-_]+/g, ' ').trim().replace(/\b(dns|dhcp|ipam|ip|ttl|dnssec)\b/gi, (w) => w.toUpperCase())
  return words ? words[0].toUpperCase() + words.slice(1) : s
}

/** One zone issue in words. */
export function issueWord(issue) {
  return ISSUE[issue] ?? issue
}

/**
 * A server sentence with its engineering words swapped for plain ones:
 * "aws.private.: High Neg-TTL" -> 'aws.private.: remembers "not found" too long',
 * "11 dns ttl anomaly" -> "11 zones with DNS timing problems".
 */
export function plainMessage(text) {
  let s = String(text ?? '')
  for (const [k, v] of Object.entries(ISSUE)) s = s.split(k).join(v)
  s = s.replace(/^(\d+) dns ttl anomaly$/, (_, n) => `${n} ${n === '1' ? 'zone has a' : 'zones have'} DNS timing ${n === '1' ? 'problem' : 'problems'}`)
  // The cutoff is said, not implied: beside "947 subnets ≥90%" on Overview,
  // "1,739 filling up" read as a contradiction (owner, 2026-11-11). The server
  // raises this at 70% (BuildSignals in go/internal/dashboard/signals.go).
  s = s.replace(/^(\d+) subnet utilization$/, (_, n) => `${n} ${n === '1' ? 'subnet is' : 'subnets are'} 70% full or more`)
  s = s.replace(/^(\d+) dhcp expired lease$/, (_, n) => `${n} expired address ${n === '1' ? 'lease' : 'leases'}`)
  s = s.replace(/^(\d+) dnssec unsigned$/, (_, n) => `${n} DNS ${n === '1' ? 'zone' : 'zones'} not signed`)
  s = s.replace(/ at (\d+)% utilization$/, ' is $1% full')
  s = s.replace(/ DNS zones( with public names)? unsigned \(DNSSEC\)$/, (_, pub) => ` DNS zones${pub || ''} not signed (DNSSEC)`)
  return s
}

const EVENT = {
  'write-authorized': 'Change allowed',
  'write-refused-read-only': 'Change blocked (read-only)',
  'tenant-write-granted': 'Changes turned on',
  'tenant-write-revoked': 'Changes turned off',
  'update-apply': 'App updated',
  'audit-export': 'Audit log exported',
  'provision-subnet': 'Subnet created',
  'provision-block': 'Address block created',
  'provision-site': 'Site built',
  'provision-seed-demo': 'Demo network built',
  'teardown-site': 'Site removed',
  'teardown-block': 'Address block removed',
  'teardown-seed-demo': 'Demo network removed',
  'dns-record-create': 'DNS record added',
  'dns-record-update': 'DNS record changed',
  'dns-record-delete': 'DNS record deleted',
  'ipam-address-delete': 'Address released',
  'selfservice-allocate': 'Address taken',
  'desk-build': 'Built on Automate',
  'desk-remove': 'Removed on Automate',
  'retag-block': 'Block tags changed',
  'iq-action-resolve': 'Insight resolved',
  'stream-aborted': 'Run stopped early',
}

// What a failed event was trying to do, for "Couldn't …".
const TRIED = {
  'provision-subnet': 'create a subnet',
  'provision-block': 'create an address block',
  'provision-site': 'build a site',
  'teardown-site': 'remove a site',
  'teardown-block': 'remove an address block',
  'dns-record-delete': 'delete a DNS record',
  'ipam-address-delete': 'release an address',
  'retag-block': 'change block tags',
  'iq-action-resolve': 'resolve an insight',
}

/**
 * An audit event kind in words. A failed or half-done variant of a known kind
 * ("provision-subnet-error") says so after the kind's own words.
 */
export function eventWord(kind) {
  const s = String(kind ?? '')
  if (EVENT[s]) return EVENT[s]
  const m = s.match(/^(.*)-(error|failed|unknown|unreadable|orphaned)$/)
  if (m && (m[2] === 'error' || m[2] === 'failed') && TRIED[m[1]]) return `Couldn't ${TRIED[m[1]]}`
  if (m && EVENT[m[1]]) {
    const why = { error: 'failed', failed: 'failed', unknown: 'result unknown', unreadable: "couldn't read it back", orphaned: 'left behind' }[m[2]]
    return `${EVENT[m[1]]} (${why})`
  }
  return categoryWord(s)
}

/**
 * The noun that goes after a count: "service" after 1, "services" after
 * anything else. Pages built their own "N things" strings and printed
 * "1 services" (sweep, 2026-11-24), so every count label says it through here.
 * A count that is not a number (still loading, not checked) takes the plural.
 */
export function noun(n, one, many = `${one}s`) {
  return n === 1 ? one : many
}

/** A count with its noun: countOf(1, 'zone') -> "1 zone", countOf(1200, 'zone') -> "1,200 zones". */
export function countOf(n, one, many = `${one}s`) {
  const shown = typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : String(n ?? '—')
  return `${shown} ${noun(n, one, many)}`
}

// The thing an incident signal is about, by name. Zone and subnet messages start with it
// ("aws.private.: High Neg-TTL", "Windows Wireless at 80% utilization"), and a
// lease message names its address ("Lease 10.0.0.5 (printer) expired"). The id
// ("ipam/subnet/abc") is the last resort: it means nothing to a reader.
export function subjectName(s) {
  const msg = String(s.message || '')
  if (s.entity_type === 'zone' && msg.includes(': ')) return msg.split(': ')[0]
  if (s.entity_type === 'subnet' && / at \d+% utilization$/.test(msg)) return msg.replace(/ at \d+% utilization$/, '') || s.entity_id
  const lease = s.entity_type === 'lease' && msg.match(/^Lease (\S+) /)
  if (lease) return lease[1]
  if (s.entity_type === 'posture') return 'All DNS zones'
  return s.entity_id || '—'
}
