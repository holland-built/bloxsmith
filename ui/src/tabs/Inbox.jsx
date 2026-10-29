import { useApi } from '../lib/api.js'
import { categoryWord } from '../lib/plainWords.js'
import { FOCUS_RING } from '../components/ui.jsx'
import OneBox from '../components/OneBox.jsx'

// The home page: what needs a look, worst first, each with the page that
// fixes it. Built from the same feeds as Overview's headline numbers, so the
// two never disagree. Incidents arrive already grouped, one row per kind.

// Same buckets as Overview's statusBucket(); only "offline" matters here.
const isOffline = (s) => {
  s = s || ''
  return !/^unknown$/i.test(s) && !/online|up|active/i.test(s) && !/degraded|warn/i.test(s) && /off|down|error|fail/i.test(s)
}

// Where each kind of incident is fixed, and the question to ask about it.
const FIX = {
  'subnet-utilization': { href: '#network?minUtil=90&focus=subnets', act: 'See full subnets', ask: 'Which subnets are nearly full?' },
  'dns-ttl-anomaly': { href: '#dns', act: 'See the zones', ask: 'Are any of my DNS zones misconfigured?' },
  'dhcp-expired-lease': { href: '#network?focus=leases', act: 'See the leases', ask: 'Which DHCP leases have expired?' },
  'dnssec-unsigned': { href: '#dns', act: 'See the zones', ask: 'Which DNS zones are not signed?' },
}

const fmt = (n) => Number(n).toLocaleString()

function inboxRows({ hosts, incidents, sec }) {
  const rows = []
  const offline = hosts ? hosts.filter((h) => isOffline(h.status)).length : 0
  if (offline) {
    rows.push({ key: 'hosts-offline', sev: 'crit', title: `${fmt(offline)} hosts are offline`, sub: `of ${fmt(hosts.length)} hosts`, href: '#infra?status=offline', act: 'See the hosts', ask: 'Which hosts are offline?' })
  }
  if (sec && sec.critical + sec.high > 0) {
    rows.push({ key: 'security', sev: sec.critical ? 'crit' : 'warn', title: `${fmt(sec.critical + sec.high)} critical or high security events`, sub: sec.note, href: '#security', act: 'See the events', ask: 'Which domains are on threat feeds?' })
  }
  for (const i of incidents ?? []) {
    rows.push({ key: i.key || i.category, sev: i.severity === 'crit' ? 'crit' : 'warn', title: `${fmt(i.count)} × ${categoryWord(i.category)}`, sub: '', ...(FIX[i.category] ?? { href: '#incidents', act: 'See them', ask: '' }) })
  }
  return rows.sort((a, b) => (a.sev === 'crit' ? 0 : 1) - (b.sev === 'crit' ? 0 : 1))
}

export default function Inbox() {
  const data = useApi('/api/data', { poll: 30000, adoptIfFresherThan: 2000 })
  const inc = useApi('/api/incidents', { poll: 60000 })
  const sec = useApi('/api/hub/security', { poll: 30000 })

  const hosts = data.data?.hosts
  const totals = data.data?._totals ?? {}
  const secOk = sec.data?.availability === 'ok'
  const secCounts = secOk ? { critical: sec.data.counts?.critical ?? 0, high: sec.data.counts?.high ?? 0, note: sec.data.truncated ? `in the latest ${sec.data.returned} events` : '' } : null
  const rows = inboxRows({ hosts, incidents: inc.data?.incidents, sec: secCounts })
  const full = rows.find((r) => r.key === 'subnet-utilization')
  if (full && totals.subnetsCrit != null) full.sub = `${fmt(totals.subnetsCrit)} are 90% full or more`

  const loading = data.loading || inc.loading || sec.loading
  // Each feed that could not be read is said, so a missing row is never taken
  // to mean "nothing wrong".
  const failed = [
    (data.error || (!data.loading && !data.data)) && 'hosts',
    (inc.error || (!inc.loading && !inc.data)) && 'incidents',
    !sec.loading && !secOk && 'security events',
  ].filter(Boolean)

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 pb-10">
      <h1 className="text-copy font-semibold">Needs a look</h1>
      <div className="mt-3 mb-5"><OneBox big /></div>
      <p className="text-copy text-muted mb-2" role="status">
        {loading
          ? 'Checking…'
          : rows.length
            ? `${rows.length} ${rows.length === 1 ? 'thing' : 'things'}, worst first.`
            : failed.length
              ? 'Nothing found in the feeds that answered.'
              : 'Nothing needs you right now.'}
      </p>
      {failed.length > 0 && !loading && (
        <p className="text-copy text-warn mb-2">
          Couldn't check {failed.join(', ')}. <button type="button" onClick={() => location.reload()} className={`text-link underline ${FOCUS_RING}`}>Try again</button>
        </p>
      )}
      {rows.length > 0 && (
        <ul className="border-t border-border" aria-label="Needs a look">
          {rows.map((r) => (
            <li key={r.key} data-inbox-row={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 border-b border-border">
              <span role="img" aria-label={r.sev === 'crit' ? 'Critical' : 'Warning'} className={`w-2.5 h-2.5 rounded-full shrink-0 ${r.sev === 'crit' ? 'bg-crit' : 'bg-warn'}`} />
              <span className="flex-1 min-w-[12rem]">
                <span className="block text-copy font-semibold">{r.title}</span>
                {r.sub && <span className="block text-note text-muted">{r.sub}</span>}
              </span>
              <span className="flex gap-2">
                <a href={r.href} className={`px-3 py-1.5 rounded-control bg-accent text-on-accent text-copy no-underline ${FOCUS_RING}`}>{r.act}</a>
                {r.ask && (
                  <a href={`#ai?q=${encodeURIComponent(r.ask)}`} aria-label={`Ask the AI: ${r.ask}`} className={`px-3 py-1.5 rounded-control text-copy text-link no-underline hover:bg-line ${FOCUS_RING}`}>Ask why</a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!loading && !rows.length && !failed.length && totals.hosts != null && (
        <p className="text-copy">{fmt(totals.hosts)} hosts and {fmt(totals.subnets)} subnets, all within limits.</p>
      )}
      <p className="mt-6 text-note text-muted">
        The full dashboards are under <a href="#overview" className="text-link">Reports</a>.
      </p>
    </div>
  )
}
