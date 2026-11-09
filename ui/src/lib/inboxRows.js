import { plainMessage } from './plainWords.js'

// The open issues on Overview's service board, worst first, each with the page
// that fixes it. Built from the same feeds as the board's measures, so the two
// never disagree.
// Incidents arrive already grouped, one row per kind.

// Same buckets as Overview's statusBucket(); only "offline" matters here. It
// holds hosts Infoblox reports as offline, down OR error, so the words on
// screen say "not online" rather than guess which one it was.
const isOffline = (s) => {
  s = s || ''
  return !/^unknown$/i.test(s) && !/online|up|active/i.test(s) && !/degraded|warn/i.test(s) && /off|down|error|fail/i.test(s)
}

// Where each kind of incident is fixed, and the question to ask about it.
const FIX = {
  // 70: the subnet signal starts there (signals.go), so the list holds every
  // subnet this row counts, not only the ones at 90%.
  'subnet-utilization': { href: '#network?minUtil=70&focus=subnets', ask: 'Which subnets are nearly full?' },
  'dns-ttl-anomaly': { href: '#dns', ask: 'Are any of my DNS zones misconfigured?' },
  'dhcp-expired-lease': { href: '#network?focus=leases', ask: 'Which DHCP leases have expired?' },
  'dnssec-unsigned': { href: '#dns', ask: 'Which DNS zones are not signed?' },
}

const fmt = (n) => Number(n).toLocaleString()

export function inboxRows({ hosts, incidents, signals, sec }) {
  const rows = []
  const offline = hosts ? hosts.filter((h) => isOffline(h.status)).length : 0
  if (offline) {
    rows.push({ key: 'hosts-offline', sev: 'crit', title: `${fmt(offline)} of ${fmt(hosts.length)} ${hosts.length === 1 ? 'host' : 'hosts'} ${offline === 1 ? 'is' : 'are'} not online`, sub: '', href: '#infra?status=offline', ask: 'Which hosts are not online?' })
  }
  if (sec && sec.critical + sec.high > 0) {
    rows.push({ key: 'security', sev: sec.critical ? 'crit' : 'warn', title: `${fmt(sec.critical + sec.high)} critical or high security events`, sub: sec.note, href: '#security', ask: 'Which domains are on threat feeds?' })
  }
  for (const i of incidents ?? []) {
    // An incident is a group of findings. When it holds exactly one, that
    // finding's own sentence ("602 of 602 DNS zones not signed") says what is
    // wrong; "1 × Zones not signed" counted the group, not the zones.
    const own = (signals ?? []).filter((sg) => sg.category === i.category)
    let text = i.count === 1 && own.length === 1 && own[0].message ? own[0].message : i.message || String(i.category).replace(/-/g, ' ')
    // The server's group message starts with its count ("11 dns ttl anomaly");
    // one that does not still gets it, so the row never loses the number.
    if (text !== own[0]?.message && !/^\d/.test(text)) text = `${i.count} ${text}`
    rows.push({ key: i.key || i.category, sev: i.severity === 'crit' ? 'crit' : 'warn', title: plainMessage(text).replace(/^\d+/, (n) => fmt(n)), sub: '', ...(FIX[i.category] ?? { href: '#incidents', ask: '' }) })
  }
  return rows.sort((a, b) => (a.sev === 'crit' ? 0 : 1) - (b.sev === 'crit' ? 0 : 1))
}
