import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { inboxRows } from '../lib/inboxRows.js'
import { useApi } from '../lib/api.js'
import { Card, CardGrid, Empty, FeedUnavailable, Skeleton, useChartTheme } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { sampleSince } from '../lib/sampleCount.js'
import { statusBucket } from '../lib/statusBucket.js'
import { useSavedChartPanels } from '../components/useSavedChartPanels.jsx'
import Tip from '../components/Tip.jsx'
import './Overview.css'

// OVERVIEW IS A SERVICE BOARD, NOT A PANEL WALL (2026-11-09).
//
// It used to be the same shape as every other tab: six number tiles, a
// collapsed "Needs a look", then eight equal panels. Two reviews (plans/ui-audit/
// AUDIT.md) found that shape was why the app read as a generic dashboard, and
// that the page never answered "what is broken, and since when". The owner
// picked the service-board variant.
//
// So the page is now one row per service the operator owns — DNS, DHCP, IPAM,
// hosts, security — with its open issues first, each issue's age, and the
// measure beside the scope it was counted over. The subnet and host panels it
// used to repeat live on Network and Infra. What stays arrangeable below the
// board is the DNS chart, licences and any chart added from Build a chart, so
// layoutKey="overview" and saved layouts keep working.
//
// Above the board sit five service tiles, and the chosen tile's detail (the
// DNS chart, or a bar for the others). The owner picked that pairing on
// 2026-11-09 from four looks built with the dashboard-design skill.

const GradientArea = lazy(() => import('../charts/GradientArea.jsx'))

// Draws its children once the box is within 400px of the screen, or once the
// browser is idle after the first draw, whichever comes first, with a Skeleton
// of the same height until then. The DNS chart below the board is the only thing
// on Overview that needs the chart library (111 KB gzipped), and it sits under
// the fold, so the library is no longer fetched and parsed ahead of the board.
// It still loads on every visit, just after the page has drawn: a placeholder
// that waited for a scroll would sit there saying "Loading…" about something
// that is not loading, which is what readers and the page checks would hear.
// Without IntersectionObserver it draws at once.
function WhenNear({ h, children }) {
  const ref = useRef(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (near) return undefined
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true)
    }, { rootMargin: '400px 0px' })
    io.observe(ref.current)
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(() => setNear(true), { timeout: 2000 })
      : setTimeout(() => setNear(true), 1000)
    return () => {
      io.disconnect()
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle)
      else clearTimeout(idle)
    }
  }, [near])
  return near ? children : <div ref={ref}><Skeleton h={h} /></div>
}

const DAY_S = 86400
const n0 = (v) => (typeof v === 'number' ? v.toLocaleString() : '—')
const seenDay = (t) => new Date(t * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
const TONE_WORD = { crit: 'Critical', warn: 'Warning', note: 'Note', ok: 'Healthy', neutral: 'Unknown' }

// Which board row an issue from lib/inboxRows.js belongs to, by key.
// Anything that matches none of them goes to "Other", so a new kind of
// incident is shown somewhere instead of silently dropped.
const ROW_OF = [['dns', 'DNS'], ['dhcp', 'DHCP'], ['subnet', 'IPAM'], ['hosts', 'Hosts'], ['security', 'Security']]
const rowOf = (key) => (ROW_OF.find(([p]) => String(key).startsWith(p)) ?? [null, 'Other'])[1]

export default function Overview() {
  const savedCharts = useSavedChartPanels('overview')
  const licenses = useApi('/api/csp/license-alerts', { poll: 30000 })
  const dns = useApi('/api/csp/dns-qps', { poll: 30000 })
  const board = useBoard(dns)

  return (
    <div className="w-full px-6 py-5">
      <div className="ov-look">
        <div className="ov-head">
          <h1>Overview</h1>
          <Updated board={board} />
        </div>
        <Tiles board={board} dns={dns} />
        <ServiceBoard board={board} dns={dns} />
      </div>
      <h2 className="text-copy font-semibold mt-8 mb-2">Charts</h2>
      <CardGrid layoutKey="overview">
        <DnsHero panelId="dns-hero" dns={dns} />
        <LicenseInventory panelId="license-inventory" licenses={licenses} />
        {savedCharts}
      </CardGrid>
    </div>
  )
}

// ---------- the board's data ----------

function useBoard(dns) {
  // The other half of the pair described in ConnStatus.jsx: the header's
  // status dot polls this same url, and whichever asks second adopts the
  // first's result instead of fetching 294KB again.
  const data = useApi('/api/data', { poll: 30000, adoptIfFresherThan: 2000 })
  const sec = useApi('/api/hub/security', { poll: 30000 })
  const inc = useApi('/api/incidents', { poll: 60000 })
  const health = useApi('/api/hub/health', { poll: 30000 })

  const totals = data.data?._totals ?? {}
  const meta = data.data?._meta ?? {}
  // A failed /api/data has no payload at all, so every slice would read as
  // [] — "you have none" over a dead backend. Requested but missing is an
  // error, never an empty estate (the rule lib/data.js gives the other tabs).
  const feedDown = !data.loading && (!!data.error || data.data == null)
  const sliceOk = (name) => !data.loading && !feedDown && meta[name] !== 'error'
  const hosts = data.data?.hosts ?? []
  const subnets = data.data?.subnets ?? []
  const leases = data.data?.leases ?? []

  const secOk = !sec.loading && !sec.error && sec.data?.availability === 'ok'
  const secCounts = secOk ? { critical: sec.data.counts?.critical ?? 0, high: sec.data.counts?.high ?? 0, note: sec.data.truncated ? `in the latest ${sec.data.returned} events` : '' } : null
  const incOk = !inc.loading && !inc.error && Array.isArray(inc.data?.incidents)
  const incidents = incOk ? inc.data.incidents : []
  const firstSeen = Object.fromEntries(incidents.map((i) => [i.key || i.category, i.first_detected_at]))
  const now = Date.now() / 1000
  const issues = inboxRows({ hosts: sliceOk('hosts') ? hosts : undefined, incidents, signals: inc.data?.signals, sec: secCounts }).map((r) => {
    const t = firstSeen[r.key]
    return { ...r, seen: typeof t === 'number' ? t : null, fresh: typeof t === 'number' && now - t < DAY_S }
  })
  const full = issues.find((r) => r.key === 'subnet-utilization')
  if (full && typeof totals.subnetsCrit === 'number') full.sub = totals.subnetsCrit ? `${n0(totals.subnetsCrit)} are 90% full or more` : 'none at 90% yet'

  const svcRows = health.loading || health.error || !Array.isArray(health.data) ? [] : health.data
  const svc = Object.fromEntries(svcRows.map((s) => [s.name, s]))
  const svcState = (name) => (health.loading ? { loading: true } : health.error ? { failed: true } : svc[name] ?? null)

  const rows = dns.data?.rows ?? []
  const dnsOk = !dns.loading && !dns.error && dns.data?.status !== 'error'
  const qps = dnsOk && rows.length ? Number(rows[rows.length - 1].avg_value) : null
  const offline = sliceOk('hosts') ? hosts.filter((h) => statusBucket(h.status) === 'offline').length : null
  const activeLeases = sliceOk('leases') ? leases.filter((l) => l.state === 'active').length : null
  const crit = sliceOk('subnets') && typeof totals.subnetsCrit === 'number' ? totals.subnetsCrit : null
  const secBad = secOk ? (sec.data.counts?.critical ?? 0) + (sec.data.counts?.high ?? 0) : null
  const since = secOk ? sampleSince(sec.data) : null

  // Each measure carries the scope it was counted over, and a feed that failed
  // says so instead of showing a number or a dash that reads as zero.
  const m = (ok, loading, text) => (loading ? 'Loading…' : ok ? text : 'unavailable')
  const issuesFor = (name) => issues.filter((r) => rowOf(r.key) === name)
  const board = [
    { name: 'DNS', href: '#dns', state: svcState('DNS'), trend: dnsOk ? rows : null, n: qps,
      measure: m(dnsOk, dns.loading, `${qps === null ? '—' : qps >= 100 ? Math.round(qps).toLocaleString() : qps.toFixed(1)} queries/s`), scope: 'hourly average, last hour' },
    { name: 'DHCP', href: '#network?focus=leases', state: svcState('DHCP'), n: activeLeases, of: sliceOk('leases') ? leases.length : null,
      measure: m(sliceOk('leases'), data.loading, `${n0(activeLeases)} active leases`), scope: sliceOk('leases') ? `of ${n0(leases.length)} leases loaded` : '' },
    { name: 'IPAM', href: '#network?minUtil=90&links=1', state: null, n: crit, of: typeof totals.subnets === 'number' ? totals.subnets : null,
      measure: m(crit !== null, data.loading, `${n0(crit)} of ${n0(totals.subnets)} subnets ≥90%`),
      scope: crit !== null && typeof totals.subnetsWarn === 'number' ? `${n0(totals.subnetsWarn - crit)} more at 70–89% · all subnets` : '' },
    { name: 'Hosts', href: '#infra?status=offline', state: null, n: offline, of: sliceOk('hosts') ? hosts.length : null,
      measure: m(offline !== null, data.loading, `${n0(offline)} of ${n0(hosts.length)} not online`),
      scope: offline !== null ? (typeof totals.hosts === 'number' && hosts.length >= totals.hosts ? 'all hosts' : `${n0(hosts.length)} loaded of ${n0(totals.hosts)}`) : '' },
    { name: 'Security', href: '#security', state: svcState('Security'), n: secBad,
      measure: m(secOk, sec.loading, `${n0(secBad)} critical or high events`),
      scope: secOk && sec.data.truncated ? `in the latest ${sec.data.returned} events${since ? `, since ${since}` : ''}` : secOk ? 'whole window' : '' },
  ].map((b) => ({ ...b, issues: issuesFor(b.name) }))
  const other = issuesFor('Other')
  if (other.length) board.push({ name: 'Other', href: '#incidents', state: null, measure: '', scope: '', issues: other })

  // The time the inventory payload arrived, not the time of this render: a
  // render caused by another feed must not make old inventory look fresh.
  const fetchedAt = useMemo(() => (data.data ? new Date() : null), [data.data])
  const coverage = [
    data.loading && !data.data && 'Checking inventory…',
    feedDown && 'Inventory feed unavailable',
    fetchedAt && `Inventory fetched ${fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    typeof totals.subnets === 'number' && `subnets: ${n0(subnets.length)} of ${n0(totals.subnets)} loaded`,
    typeof totals.hosts === 'number' && `hosts: ${n0(hosts.length)} of ${n0(totals.hosts)} loaded`,
    svcRows.some((s) => s.availability === 'partial') && 'services: partial list (500-row limit)',
    totals.degraded && 'some whole-network counts could not be fetched this cycle',
  ].filter(Boolean).join(' · ')

  // "none" is only said when the feeds that would have reported an issue
  // answered. Otherwise the row says its issues were not checked.
  // 'loading' while the feed is still on its way, so a slow first load never
  // reads as a failure.
  const checked = (loading, ok) => (loading ? 'loading' : ok)
  const incChecked = checked(inc.loading, incOk)
  const issuesChecked = { DNS: incChecked, DHCP: incChecked, IPAM: incChecked, Hosts: checked(data.loading, sliceOk('hosts')), Security: checked(sec.loading, secOk), Other: incChecked }
  // A clear Security row over a truncated sample is only clear for that sample.
  // Likewise a clear Hosts row over part of the hosts is only clear for those.
  const hostsPartial = sliceOk('hosts') && typeof totals.hosts === 'number' && hosts.length < totals.hosts
  const noneLabel = {
    Security: secOk && sec.data.truncated ? `none in the latest ${sec.data.returned} events` : null,
    Hosts: hostsPartial ? `none among the ${n0(hosts.length)} loaded` : null,
  }
  return { board, coverage, issuesChecked, noneLabel, dnsOk, feedDown, fetchedAt }
}

// ---------- the top of the page: tiles, the chosen tile's chart, the board ----------
//
// The owner picked this look on 2026-11-09 from four versions shown on the real
// page (the dashboard-design skill, ~/.claude/skills/dashboard-design). Words on
// screen are a number, a unit and a short label; every explanation is in a tip
// that opens on hover, keyboard focus or tap.

const SEV_RANK = { crit: 3, warn: 2, note: 1 }
// DNS, DHCP and Security have their own health check. IPAM and Hosts do not, so
// for those two the inventory and the incidents feed are the whole answer.
const HAS_HEALTH = new Set(['DNS', 'DHCP', 'Security'])
const fmt = (v, d = 0) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : '—')
const upOf = (meta) => { const m = /(\d+)\s*\/\s*(\d+)\s*up/.exec(meta || ''); return m ? { up: +m[1], total: +m[2] } : null }
const worst = (issues) => issues.reduce((w, r) => ((SEV_RANK[r.sev] || 0) > (SEV_RANK[w] || 0) ? r.sev : w), null)

// A service's state in one word. "Healthy" only when every feed that would
// have reported a problem answered; a failed, missing or unknown check is
// "Not checked", never good news.
function verdict(b, checked) {
  if (!b) return { word: 'Not checked', sev: 'none' }
  if (b.measure === 'Loading…' || checked === 'loading' || b.state?.loading) return { word: 'Checking', sev: 'none' }
  const w = worst(b.issues)
  const st = b.state?.status
  if (w === 'crit' || st === 'crit') return { word: 'Act', sev: 'crit' }
  if (w === 'warn' || st === 'warn') return { word: 'Look', sev: 'warn' }
  // Subnets 90% full are worth a look even before an incident is raised, so
  // the tile never says Healthy beside a count of them.
  if (b.name === 'IPAM' && b.n > 0) return { word: 'Look', sev: 'warn' }
  if (b.measure === 'unavailable') return { word: 'Unavailable', sev: 'none' }
  if (checked !== true || b.state?.failed) return { word: 'Not checked', sev: 'none' }
  if (HAS_HEALTH.has(b.name) && st !== 'ok') return { word: 'Not checked', sev: 'none' }
  return { word: 'Healthy', sev: 'ok' }
}

// The tile for each service: the number, its unit, what it is out of, and the
// tip. Built from the board rows, so a tile and its row never disagree.
function tiles(board, dns) {
  const by = Object.fromEntries(board.board.map((b) => [b.name, b]))
  const rows = board.dnsOk ? dns.data?.rows ?? [] : []
  const first = rows.length > 1 ? Number(rows[0].avg_value) : null
  const up = (b) => upOf(b?.state?.meta)
  const outOf = (b) => (up(b) ? `${up(b).up} of ${up(b).total} up` : null)
  const t = [
    { name: 'DNS', value: fmt(by.DNS?.n, 1), unit: 'queries/s', right: outOf(by.DNS), was: first },
    { name: 'DHCP', value: fmt(by.DHCP?.n), unit: 'active leases', right: outOf(by.DHCP) },
    { name: 'IPAM', value: fmt(by.IPAM?.n), unit: 'subnets ≥90%', right: typeof by.IPAM?.of === 'number' ? `of ${fmt(by.IPAM.of)}` : null, fill: by.IPAM?.n / by.IPAM?.of },
    { name: 'Hosts', value: fmt(by.Hosts?.n), unit: 'not online', right: typeof by.Hosts?.of === 'number' ? `of ${fmt(by.Hosts.of)}` : null, fill: by.Hosts?.n / by.Hosts?.of },
    { name: 'Security', value: fmt(by.Security?.n), unit: 'critical or high', right: outOf(by.Security) },
  ]
  return t.map((x) => {
    const b = by[x.name]
    const checked = board.issuesChecked[x.name]
    const tip = [b?.measure, b?.scope, b?.state?.meta].filter(Boolean).join(' · ')
    const fill = x.fill ?? (up(b) ? up(b).up / up(b).total : null)
    return { ...x, b, checked, tip, fill, good: x.fill == null, v: verdict(b, checked) }
  })
}

// A volume change is neither good nor bad, so it stays grey.
function Change({ was, now }) {
  if (!was || typeof now !== 'number') return null
  const d = Math.round(((now - was) / was) * 100)
  return <span className="ov-delta">{d === 0 ? '±0%' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%`} <span className="ov-muted">vs 24h ago</span></span>
}

// Ticks filled to a share. Good-when-full bars (servers up) go green and turn
// amber or red when short; bad-when-full bars (subnets full) stay pale until
// there is something to see.
function TickBar({ fill, good, sev, label }) {
  if (fill == null || !Number.isFinite(fill)) return <div className="ov-ticks ov-ticks-none" aria-hidden="true" />
  const n = 48
  const on = Math.max(fill > 0 ? 1 : 0, Math.round(fill * n))
  const tone = good ? sev : fill > 0 ? sev : 'ok'
  return (
    <div className="ov-ticks" role="img" aria-label={label}>
      {Array.from({ length: n }, (_, i) => <i key={i} className={i < on ? `on ${tone}` : ''} />)}
    </div>
  )
}

// The last 24 hours of DNS queries. The last hour is not finished, so its
// segment is dashed. Each hour has its own tip.
function DnsChart({ dns, ok }) {
  if (dns.loading) return <Skeleton h={200} />
  if (!ok) return <FeedUnavailable label="DNS query rate feed unavailable" />
  const rows = dns.data?.rows ?? []
  const v = rows.map((r) => Number(r.avg_value) || 0)
  if (v.length < 2) return <p className="ov-muted ov-pad">No DNS history yet</p>
  const max = Math.max(...v) * 1.15 || 1
  const W = 720, H = 200
  const x = (i) => (i / (v.length - 1)) * W
  const y = (val) => H - (val / max) * H
  const solid = v.slice(0, -1).map((val, i) => `${x(i)},${y(val)}`).join(' ')
  const area = `0,${H} ${v.map((val, i) => `${x(i)},${y(val)}`).join(' ')} ${W},${H}`
  const hour = (h) => { const d = new Date(h); return isNaN(d) ? h : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  return (
    <div className="ov-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`DNS queries per second, last 24 hours: from ${v[0].toFixed(1)} to ${v[v.length - 1].toFixed(1)}`}>
        <defs><linearGradient id="ovDnsFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--ov-accent)" stopOpacity=".18" /><stop offset="1" stopColor="var(--ov-accent)" stopOpacity="0" /></linearGradient></defs>
        <polygon points={area} fill="url(#ovDnsFill)" />
        <polyline points={solid} fill="none" stroke="var(--ov-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <polyline points={`${x(v.length - 2)},${y(v[v.length - 2])} ${x(v.length - 1)},${y(v[v.length - 1])}`} fill="none" stroke="var(--ov-accent)" strokeWidth="2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="ov-hits">
        {rows.map((r, i) => (
          <Tip key={r.hour} className="ov-hit" tip={<><b>{v[i].toFixed(1)}</b> queries/s<span className="ov-tip-sub">{hour(r.hour)}{i === v.length - 1 ? ' · this hour so far' : ''}</span></>}>
            <span className="sr-only">{hour(r.hour)}</span>
          </Tip>
        ))}
      </div>
      <div className="ov-axis"><span>24h ago</span><span>12h ago</span><span>Now</span></div>
    </div>
  )
}

// Five tiles in one card. Clicking one shows its detail below: the DNS chart,
// or for the others a bar against what it is out of, with a link to its page.
function Tiles({ board, dns }) {
  const T = tiles(board, dns)
  const [sel, setSel] = useState('DNS')
  const cur = T.find((t) => t.name === sel) ?? T[0]
  return (
    <>
      <section className="ov-card ov-kpis" aria-label="Services at a glance">
        {T.map((t) => (
          <button key={t.name} type="button" aria-pressed={sel === t.name} onClick={() => setSel(t.name)} className="ov-kpi" title={t.tip || undefined} aria-describedby={t.tip ? `ov-tip-${t.name}` : undefined}>
            <span className="ov-kpi-in">
              <span className="ov-kpi-top"><span>{t.name}</span><span className={`ov-verdict ${t.v.sev}`}>{t.v.word}</span></span>
              <span className="ov-num">{t.value} <small>{t.unit}</small></span>
              {t.was != null ? <Change was={t.was} now={t.b?.n} /> : <span className="ov-muted ov-small">{t.right ?? ' '}</span>}
            </span>
            {t.tip && <span id={`ov-tip-${t.name}`} className="sr-only">{t.tip}</span>}
          </button>
        ))}
      </section>
      <section className="ov-card" aria-label={`${cur.name} detail`}>
        <div className="ov-card-head"><h2>{cur.name}</h2><span className="ov-muted">{cur.name === 'DNS' ? 'Last 24 hours' : cur.right}</span></div>
        {cur.name === 'DNS' ? <DnsChart dns={dns} ok={board.dnsOk} /> : (
          <div className="ov-pad">
            <TickBar fill={cur.fill} good={cur.good} sev={cur.v.sev} label={`${cur.name}: ${cur.value} ${cur.unit} ${cur.right ?? ''}`} />
          </div>
        )}
        {/* The chosen tile's explanation, written out: picking a tile by tap
            or keyboard shows it, not only a mouse hover over the tile. */}
        <div className="ov-foot ov-pad ov-detail-foot"><span className="ov-muted">{cur.tip}</span><a className="ov-act" href={cur.b?.href}>Open {cur.name}</a></div>
      </section>
    </>
  )
}

// Fourteen days would need a daily history Bloxsmith does not keep. What it
// does know is the day each open issue was first seen, so a day is coloured
// only when an issue open now was already open then; every other past day is
// an outline ("no record"), never a green day. Today also takes the service's
// own state, and is green only when the row is Healthy.
function Strip({ issues, state, v, days = 10 }) {
  const now = Date.now() / 1000
  // Local midnights by calendar date, so a daylight-saving change never
  // skips or doubles a day.
  const midnight = (back) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back); return d.getTime() / 1000 }
  const cells = Array.from({ length: days }, (_, i) => {
    const start = midnight(days - 1 - i)
    const end = midnight(days - 2 - i)
    const today = i === days - 1
    const open = issues.filter((r) => (r.seen ?? now) < end)
    let sev = worst(open)
    if (sev === 'note') sev = null
    if (today) sev = v.sev === 'none' ? sev : v.sev
    return { start, sev, n: open.length, today }
  })
  return (
    <div className="ov-strip">
      {cells.map((c) => (
        <Tip key={c.start} className={`ov-day ${c.sev ?? 'none'}`}
          tip={c.sev == null ? `${seenDay(c.start)}: no record` : `${seenDay(c.start)}: ${c.n ? `${c.n} open` : 'nothing open'}${c.today && state?.meta ? ` · ${state.meta}` : ''}`}>
          <span className="sr-only">{seenDay(c.start)}</span>
        </Tip>
      ))}
    </div>
  )
}

// An issue as a pill: its title on screen; severity, age and detail in the tip.
// A standing issue (first seen more than a day ago) is drawn hollow, so old
// debt does not shout like a new outage. "Ask why" shows on the row under the
// pointer or with focus, always on touch screens (owner, 2026-11-09), and so
// does "Open".
function Issue({ r }) {
  const tip = `${TONE_WORD[r.sev]}${r.fresh ? ', new' : ''}: ${r.title}${r.sub ? ` — ${r.sub}` : ''} · ${r.seen ? `open since ${seenDay(r.seen)}` : 'first seen not tracked'}`
  return (
    <li data-inbox-row={r.key} className="ov-issue">
      {/* The pill is not a link, so tapping it opens its tip instead of
          leaving the page. "Open" beside it goes to where it is fixed. */}
      <Tip tip={tip} className={`ov-flag ${r.sev}${r.fresh ? '' : ' standing'}`}>
        <span aria-hidden="true" className={`ov-dot ${r.sev}`} />
        {r.title}
      </Tip>
      <a href={r.href} aria-label={`Open: ${r.title}`} className="ov-act ov-ask">Open</a>
      {r.ask && <a href={`#ai?q=${encodeURIComponent(r.ask)}`} aria-label={`Ask the AI: ${r.ask}`} className="ov-act ov-ask">Ask why</a>}
    </li>
  )
}

function IssueList({ b, checked, none }) {
  if (b.issues.length) return <ul className="ov-issues">{b.issues.map((r) => <Issue key={r.key} r={r} />)}</ul>
  return <span className="ov-muted">{checked === 'loading' ? 'Checking…' : checked ? none || 'none open' : 'not checked: feed unavailable'}</span>
}

// The number on a row: big when there is one, the word when the feed is
// loading or failed. The tip holds the measure and the scope it was counted over.
function Measure({ b, t }) {
  if (!t) return <span className="ov-muted">{b.measure || ' '}</span>
  if (b.measure === 'Loading…' || b.measure === 'unavailable') return <span className="ov-muted">{b.measure}</span>
  return <Tip tip={[b.measure, b.scope].filter(Boolean).join(' · ')} className="ov-num ov-row-num">{t.value} <small>{t.unit}</small></Tip>
}

// The board can be folded to one line of counts, so the charts below come up
// to the top (owner, 2026-11-09). The choice is kept in this browser only.
const BOARD_KEY = 'bloxsmith.overview.boardHidden'

function readHidden() {
  try {
    return localStorage.getItem(BOARD_KEY) === '1'
  } catch {
    return false
  }
}

// "DNS 1 warning, 1 note · IPAM 1 critical", or "no open issues". It never
// claims "no open issues" while a feed is still loading or failed to load,
// the same rule the open board follows.
function boardSummary(rows, checked) {
  const parts = rows
    .map((b) => {
      const n = (sev) => b.issues.filter((r) => r.sev === sev).length
      const words = [['crit', 'critical'], ['warn', 'warning'], ['note', 'note']]
        .filter(([sev]) => n(sev))
        .map(([sev, w]) => `${n(sev)} ${w}${n(sev) > 1 && sev !== 'crit' ? 's' : ''}`)
      return words.length ? `${b.name} ${words.join(', ')}` : null
    })
    .filter(Boolean)
  const states = rows.map((b) => checked[b.name])
  const tail = states.some((c) => !c) ? 'some feeds not checked' : states.includes('loading') ? 'still checking' : null
  if (!parts.length) return tail ? `none found yet, ${tail}` : 'no open issues'
  return tail ? `${parts.join(' · ')} · ${tail}` : parts.join(' · ')
}

function ServiceBoard({ board, dns }) {
  const [hidden, setHidden] = useState(readHidden)
  const T = Object.fromEntries(tiles(board, dns).map((t) => [t.name, t]))
  const toggle = () => {
    const next = !hidden
    setHidden(next)
    try {
      localStorage.setItem(BOARD_KEY, next ? '1' : '0')
    } catch {
      // Storage off: the choice lasts until the page reloads.
    }
  }
  return (
    <section className="ov-card" aria-labelledby="ov-board">
      <div className="ov-card-head">
        <h2 id="ov-board">Services</h2>
        <span className="ov-head-right">
          {hidden && <span className="ov-muted" data-board-summary="">{boardSummary(board.board, board.issuesChecked)}</span>}
          <button type="button" onClick={toggle} aria-expanded={!hidden} aria-controls="ov-board-table" className="ov-link">{hidden ? 'Show' : 'Hide'}</button>
        </span>
      </div>
      <div id="ov-board-table" hidden={hidden} role="region" aria-label="Service board" tabIndex={0} className="ov-board-box">
        <table className="ov-board" data-board="">
          <thead className="sr-only">
            <tr><th scope="col">Service</th><th scope="col">Now</th><th scope="col">Open issues</th><th scope="col">Last 10 days</th><th scope="col">State</th></tr>
          </thead>
          <tbody>
            {board.board.map((b) => {
              const t = T[b.name]
              const v = t ? t.v : verdict(b, board.issuesChecked[b.name])
              // The service's own label ("degraded") only when it says the same
              // as the verdict; a worse open issue or a failed feed wins.
              const word = (b.state?.statusLabel && b.state.status === v.sev) ? b.state.statusLabel : v.word
              return (
                <tr key={b.name} data-board-row={b.name}>
                  <th scope="row"><a href={b.href}>{b.name}</a></th>
                  <td><Measure b={b} t={t} /></td>
                  <td className="ov-mid"><IssueList b={b} checked={board.issuesChecked[b.name]} none={board.noneLabel[b.name]} /></td>
                  <td><Strip issues={b.issues} state={b.state} v={v} /></td>
                  <td className="ov-r"><span className={`ov-chip ${v.sev}`}>{word}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// "Updated 11:02 PM" from when the inventory arrived, not when the page drew.
// Its tip is the coverage line: what was loaded, and what could not be.
function Updated({ board }) {
  const label = board.feedDown ? 'Inventory feed unavailable' : board.fetchedAt ? `Updated ${board.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Checking…'
  return (
    <Tip tip={board.coverage || null} className="ov-pill" data-coverage="">
      <span className={`ov-live ${board.feedDown ? 'down' : board.fetchedAt ? '' : 'wait'}`} aria-hidden="true" />{label}
    </Tip>
  )
}

// ---------- license inventory ----------

// Coarsens a day count into a glanceable label: whole days under ~2 years,
// otherwise months (under ~5 years) or whole years beyond that.
function formatRemaining(days) {
  if (days == null) return '—'
  const abs = Math.abs(days)
  const sign = days < 0 ? 'ago' : ''
  if (abs < 730) return `${abs.toLocaleString()}d${sign ? ' ' + sign : ''}`
  if (abs < 1825) return `~${Math.round(abs / 30.44)}mo${sign ? ' ' + sign : ''}`
  return `~${Math.round(abs / 365.25)}y${sign ? ' ' + sign : ''}`
}

function LicenseInventory({ licenses, panelId }) {
  const { COLORS } = useChartTheme()
  const rows = licenses.data?.licenses ?? []
  const unavailable = !!licenses.error || licenses.data?.status === 'error'

  const columns = [
    { key: 'name', label: 'Name', grow: true },
    { key: 'sku', label: 'SKU', mono: true, grow: true },
    {
      key: 'state',
      label: 'State',
      render: (state, r) => (
        <span className="flex items-center gap-1.5">
          <span>{state || '—'}</span>
          {r._evaluation && (
            <span className="inline-block rounded-full px-2 py-0.5 text-note font-medium bg-line text-muted">Eval</span>
          )}
        </span>
      ),
    },
    { key: 'expiry', label: 'Expiry' },
    {
      key: 'remaining',
      label: 'Time Left',
      align: 'right',
      sortable: true,
      // Unknown expiry sorts as +Infinity, never -Infinity: ascending order means
      // "most imminent first", so -Infinity would park unparseable rows at the top
      // as if they were the most urgent thing on the panel.
      sortAccessor: (r) => (r._days == null ? Infinity : r._days),
      render: (_v, r) => (
        <span style={r._days != null && r._days < 30 ? { color: COLORS.crit } : r._days != null && r._days < 90 ? { color: COLORS.warn } : undefined} className={r._days == null ? 'tabular-nums text-muted' : 'tabular-nums'}>
          {formatRemaining(r._days)}
        </span>
      ),
    },
    {
      key: 'quantity',
      // "QTY" not "Quantity": the auto-sizer measures header text in the cell
      // font, so it under-measures uppercase letter-spaced headers whose cells
      // are short ("1,000"). "QUANTITY" clipped to "QUAN…" even at full width.
      // Known gap — tests/table-sizing.spec.ts only asserts on body cells, so
      // it does not catch clipped headers.
      label: 'Qty',
      align: 'right',
      render: (q) => <span className="text-muted tabular-nums">{typeof q === 'number' ? q.toLocaleString() : '—'}</span>,
    },
  ]

  const now = Date.now()
  const tableRows = rows.map((l, i) => {
    let expiry = '—'
    let days = null
    if (l.expiry) {
      const d = new Date(l.expiry)
      if (!isNaN(d)) {
        expiry = d.toLocaleDateString()
        days = Math.round((d.getTime() - now) / 86400000)
      } else {
        expiry = l.expiry
      }
    }
    return {
      name: l.name || '—',
      sku: l.sku || '—',
      state: l.state || '—',
      expiry,
      remaining: formatRemaining(days),
      quantity: typeof l.quantity === 'number' ? l.quantity : Number(l.quantity) || 0,
      _evaluation: !!l.evaluation,
      _days: days,
      _key: l.id ?? i,
    }
  })

  return (
    <Card
      panelId={panelId}
      // span 6, not 4: this panel now carries six columns (name, sku, state,
      // expiry, time left, quantity). At span 4 the added column pushed the
      // total past the card width, so the auto-sizer shrank headers until
      // "QUANTITY" clipped to "QUAN…" — while two grid columns sat empty to the
      // right. Full width removes both the clip and the dead space.
      span={6}
      title="License Inventory"
      right={unavailable ? null : <span className="text-note text-muted tabular-nums">{rows.length.toLocaleString()} licenses</span>}
    >
      {licenses.loading ? (
        <Skeleton h={220} />
      ) : unavailable ? (
        <FeedUnavailable label="License feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no license data available</Empty>
      ) : (
        <DataTable
          rows={tableRows}
          columns={columns}
          rowKey={(r) => r._key}
          maxHeight={280}
          rowCap={50}
        />
      )}
    </Card>
  )
}

// ---------- hero ----------

function DnsHero({ dns, panelId }) {
  const { COLORS } = useChartTheme()
  const rows = dns.data?.rows ?? []
  const status = dns.data?.status
  const chartData = rows.map((r) => {
    let label = r.hour
    const d = new Date(r.hour)
    if (!isNaN(d)) label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return { label, value: Number(r.avg_value) || 0 }
  })
  const current = chartData.at(-1)?.value
  const first = chartData[0]?.value
  const delta = first ? ((current - first) / first) * 100 : null
  const flat = delta != null && Math.abs(delta) < 0.05
  // Say how far back the first point is, read from the rows themselves, not
  // "first hour". Grey either way: more DNS traffic is not good or bad news.
  const spanH = rows.length > 1 ? Math.round((new Date(rows.at(-1).hour) - new Date(rows[0].hour)) / 3600000) : null
  const vs = Number.isFinite(spanH) && spanH > 0 ? `vs ${spanH}h ago` : 'vs first hour'

  return (
    <Card
      panelId={panelId}
      span={4}
      // The heading is a clickable <span> so it can deep-link to the DNS tab,
      // and a React node is not a name — "Arrange this page" listed this panel
      // as "dns-hero". The words are the heading's own, verbatim, so the row in
      // the popup and the heading on screen are the same phrase to look for.
      panelName="DNS Query Rate — 24h"
      title={<span role="button" tabIndex={0} onClick={() => { location.hash = 'dns' }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = 'dns' } }} className="cursor-pointer hover:opacity-80 transition-opacity">DNS Query Rate — 24h</span>}
      right={<span className="flex items-center gap-1.5 text-note text-muted"><i className="w-2 h-2 rounded-mark inline-block" style={{ background: COLORS.series }} />queries per second</span>}
    >
      {dns.loading ? (
        <Skeleton h={250} />
      ) : dns.error || status === 'error' ? (
        <FeedUnavailable label="DNS query rate feed unavailable" />
      ) : chartData.length === 0 ? (
        <Empty />
      ) : (
        <>
          <div className="flex items-center gap-4 my-2">
            <span className="text-figure font-semibold tracking-tight">{current?.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
            {delta != null && (
              <span className="text-note" style={{ color: COLORS.other }}>
                {flat ? '— flat' : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}%`} {vs}
              </span>
            )}
          </div>
          {/* The headline above this chart already rounds the same series to
              one decimal; the tooltip used to answer `value : 346.1144444444444`
              for the very same point. One decimal, and the unit spelled out. */}
          <WhenNear h={230}>
            <Suspense fallback={<Skeleton h={230} />}>
              <GradientArea
                label="DNS Query Rate — 24h"
                data={chartData}
                color={COLORS.series}
                gradientId="dnsFill"
                unit="queries per second"
                height={230}
                yDomain={['dataMin - 0.5', 'dataMax + 0.5']}
              />
            </Suspense>
          </WhenNear>
        </>
      )}
    </Card>
  )
}
