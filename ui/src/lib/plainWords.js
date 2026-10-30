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
  s = s.replace(/^(\d+) subnet utilization$/, (_, n) => `${n} ${n === '1' ? 'subnet is' : 'subnets are'} filling up`)
  s = s.replace(/^(\d+) dhcp expired lease$/, (_, n) => `${n} expired address ${n === '1' ? 'lease' : 'leases'}`)
  s = s.replace(/^(\d+) dnssec unsigned$/, (_, n) => `${n} DNS ${n === '1' ? 'zone' : 'zones'} not signed`)
  s = s.replace(/ at (\d+)% utilization$/, ' is $1% full')
  s = s.replace(/ DNS zones unsigned \(DNSSEC\)$/, ' DNS zones not signed (DNSSEC)')
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
