import { useApi } from '../lib/api.js'
import { plainMessage } from '../lib/plainWords.js'
import { FOCUS_RING } from './ui.jsx'

// A short strip at the top of Overview: what needs a look, worst first, each
// with the page that fixes it. It sits above the graphs, never instead of them,
// because a NOC screen has to show the graphs without a click. Built from the
// same feeds as Overview's headline numbers, so the two never disagree.
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
  'subnet-utilization': { href: '#network?minUtil=90&focus=subnets', ask: 'Which subnets are nearly full?' },
  'dns-ttl-anomaly': { href: '#dns', ask: 'Are any of my DNS zones misconfigured?' },
  'dhcp-expired-lease': { href: '#network?focus=leases', ask: 'Which DHCP leases have expired?' },
  'dnssec-unsigned': { href: '#dns', ask: 'Which DNS zones are not signed?' },
}

const fmt = (n) => Number(n).toLocaleString()

function inboxRows({ hosts, incidents, signals, sec }) {
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
    const text = i.count === 1 && own.length === 1 && own[0].message ? own[0].message : i.message || `${i.count} ${String(i.category).replace(/-/g, ' ')}`
    rows.push({ key: i.key || i.category, sev: i.severity === 'crit' ? 'crit' : 'warn', title: plainMessage(text).replace(/^\d+/, (n) => fmt(n)), sub: '', ...(FIX[i.category] ?? { href: '#incidents', ask: '' }) })
  }
  return rows.sort((a, b) => (a.sev === 'crit' ? 0 : 1) - (b.sev === 'crit' ? 0 : 1))
}

export default function NeedsALook() {
  const data = useApi('/api/data', { poll: 30000, adoptIfFresherThan: 2000 })
  const inc = useApi('/api/incidents', { poll: 60000 })
  const sec = useApi('/api/hub/security', { poll: 30000 })

  const hosts = data.data?.hosts
  const totals = data.data?._totals ?? {}
  const secOk = sec.data?.availability === 'ok'
  const secCounts = secOk ? { critical: sec.data.counts?.critical ?? 0, high: sec.data.counts?.high ?? 0, note: sec.data.truncated ? `in the latest ${sec.data.returned} events` : '' } : null
  const rows = inboxRows({ hosts, incidents: inc.data?.incidents, signals: inc.data?.signals, sec: secCounts })
  const full = rows.find((r) => r.key === 'subnet-utilization')
  if (full && totals.subnetsCrit != null) full.sub = totals.subnetsCrit ? `${fmt(totals.subnetsCrit)} are 90% full or more` : 'none at 90% yet'

  const loading = data.loading || inc.loading || sec.loading
  // Each feed that could not be read is said, so a missing row is never taken
  // to mean "nothing wrong".
  const failed = [
    (data.error || (!data.loading && !data.data)) && 'hosts',
    (inc.error || (!inc.loading && !inc.data)) && 'incidents',
    !sec.loading && !secOk && 'security events',
  ].filter(Boolean)

  return (
    <section aria-labelledby="needs-a-look" data-needs-a-look="" className="mb-4">
      <h2 id="needs-a-look" className="text-copy font-semibold">
        Needs a look
        <span className="ml-2 font-normal text-muted" role="status">
          {loading
            ? 'Checking…'
            : rows.length
              ? `${rows.length}, worst first`
              : failed.length
                ? 'nothing found in the feeds that answered'
                : 'nothing right now'}
        </span>
      </h2>
      {failed.length > 0 && !loading && (
        <p className="text-copy text-warn mt-1">
          Couldn't check {failed.join(', ')}. <button type="button" onClick={() => location.reload()} className={`text-link underline ${FOCUS_RING}`}>Try again</button>
        </p>
      )}
      {rows.length > 0 && (
        <ul className="mt-2 border-t border-border" aria-label="Needs a look">
          {rows.map((r) => (
            <li key={r.key} data-inbox-row={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 border-b border-border">
              <span role="img" aria-label={r.sev === 'crit' ? 'Critical' : 'Warning'} className={`w-2.5 h-2.5 rounded-full shrink-0 ${r.sev === 'crit' ? 'bg-crit' : 'bg-warn'}`} />
              {/* The sentence is the link. A column of identical buttons sat far
                  from the words it belonged to and drew the eye before them. */}
              <span className="flex-1 min-w-[12rem] text-copy">
                <a href={r.href} className={`font-semibold text-txt no-underline hover:underline hover:text-link ${FOCUS_RING}`}>{r.title}</a>
                {r.sub && <span className="text-muted"> · {r.sub}</span>}
                {r.ask && (
                  <a href={`#ai?q=${encodeURIComponent(r.ask)}`} aria-label={`Ask the AI: ${r.ask}`} className={`ml-3 text-note text-link underline ${FOCUS_RING}`}>Ask why</a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
