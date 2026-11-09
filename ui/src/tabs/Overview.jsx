import { lazy, Suspense, useMemo, useState } from 'react'
import { inboxRows } from '../lib/inboxRows.js'
import { useApi } from '../lib/api.js'
import { Card, CardGrid, Empty, FeedUnavailable, FOCUS_RING, Skeleton, useChartTheme } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { StatusPill } from '../components/kit.jsx'
import { sampleSince } from '../lib/sampleCount.js'
import { useSavedChartPanels } from '../components/useSavedChartPanels.jsx'

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

const GradientArea = lazy(() => import('../charts/GradientArea.jsx'))

const DAY_S = 86400
const n0 = (v) => (typeof v === 'number' ? v.toLocaleString() : '—')
const seenDay = (t) => new Date(t * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
const TONE_WORD = { crit: 'Critical', warn: 'Warning', note: 'Note', ok: 'Healthy', neutral: 'Unknown' }
// Only crit and warn are operational states. A service whose state could not
// be read is Unknown, not a warning about it.
const svcTone = (s) => (s === 'crit' ? 'crit' : s === 'warn' ? 'warn' : s === 'ok' ? 'ok' : 'neutral')

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
      <h1 className="text-copy font-semibold tracking-tight mb-1">Overview</h1>
      <p className="text-copy text-muted mb-4 max-w-[75ch]" data-coverage="">{board.coverage}</p>
      <ServiceBoard board={board} />
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
    { name: 'DNS', href: '#dns', state: svcState('DNS'), trend: dnsOk ? rows : null,
      measure: m(dnsOk, dns.loading, `${qps === null ? '—' : qps >= 100 ? Math.round(qps).toLocaleString() : qps.toFixed(1)} queries/s`), scope: 'hourly average, last hour' },
    { name: 'DHCP', href: '#network?focus=leases', state: svcState('DHCP'),
      measure: m(sliceOk('leases'), data.loading, `${n0(activeLeases)} active leases`), scope: sliceOk('leases') ? `of ${n0(leases.length)} leases loaded` : '' },
    { name: 'IPAM', href: '#network?minUtil=90', state: null,
      measure: m(crit !== null, data.loading, `${n0(crit)} of ${n0(totals.subnets)} subnets ≥90%`),
      scope: crit !== null && typeof totals.subnetsWarn === 'number' ? `${n0(totals.subnetsWarn - crit)} more at 70–89% · all subnets` : '' },
    { name: 'Hosts', href: '#infra?status=offline', state: null,
      measure: m(offline !== null, data.loading, `${n0(offline)} of ${n0(hosts.length)} not online`),
      scope: offline !== null ? (typeof totals.hosts === 'number' && hosts.length >= totals.hosts ? 'all hosts' : `${n0(hosts.length)} loaded of ${n0(totals.hosts)}`) : '' },
    { name: 'Security', href: '#security', state: svcState('Security'),
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
  return { board, coverage, issuesChecked, noneLabel }
}

// ---------- the board ----------

function SevMark({ sev, standing }) {
  const c = sev === 'crit' ? 'var(--color-crit)' : sev === 'warn' ? 'var(--color-warn)' : 'var(--color-muted)'
  return <span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-full shrink-0 mt-1" style={standing ? { boxShadow: `inset 0 0 0 2px ${c}` } : { background: c }} />
}

// An issue: its severity in words, what it is, and how long it has been open.
// A standing issue (first seen more than a day ago) keeps its word but is drawn
// hollow and muted, so old debt does not shout like a new outage. An issue
// whose first sighting is not tracked says so instead of claiming an age.
function Issue({ r }) {
  const standing = !r.fresh
  return (
    <li data-inbox-row={r.key} className="group flex items-start gap-2 py-0.5">
      <SevMark sev={r.sev} standing={standing} />
      <span className="min-w-0">
        <span className={standing || r.sev === 'note' ? 'text-muted' : r.sev === 'crit' ? 'text-crit' : 'text-warn'}>{TONE_WORD[r.sev]}{r.fresh ? ', new' : ''}: </span>
        <a href={r.href} className={`text-txt hover:underline ${FOCUS_RING}`}>{r.title}</a>
        {r.sub && <span className="text-muted"> — {r.sub}</span>}
        <span className="text-muted"> · {r.seen ? `open since ${seenDay(r.seen)}` : 'first seen not tracked'}</span>
        {/* One "Ask why" on every line read as clutter (owner, 2026-11-09).
            It now shows on the line under the pointer, and on keyboard focus
            it is always visible, so nobody loses it. */}
        {r.ask && (
          <a href={`#ai?q=${encodeURIComponent(r.ask)}`} aria-label={`Ask the AI: ${r.ask}`} className={`ml-2 text-link underline opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ${FOCUS_RING}`}>Ask why</a>
        )}
      </span>
    </li>
  )
}

function StateCell({ state }) {
  if (!state) return <span className="text-muted">no service state</span>
  if (state.loading) return <span className="text-muted">Loading…</span>
  if (state.failed) return <span className="text-muted">unavailable</span>
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <StatusPill tone={svcTone(state.status)}>{state.statusLabel || TONE_WORD[svcTone(state.status)]}</StatusPill>
      {state.meta && <span className="text-muted tabular-nums">{state.meta}</span>}
    </span>
  )
}

function Spark({ rows }) {
  const v = rows.map((r) => Number(r.avg_value) || 0)
  if (v.length < 2) return null
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1
  const pts = v.map((y, i) => `${(i / (v.length - 1)) * 120},${26 - ((y - lo) / span) * 24}`).join(' ')
  return (
    <svg width="120" height="28" role="img" aria-label={`Last 24 hours: between ${lo.toFixed(1)} and ${hi.toFixed(1)} queries per second`}>
      <polyline points={pts} fill="none" stroke="var(--color-series)" strokeWidth="1.5" />
    </svg>
  )
}

function IssueList({ b, checked, none }) {
  if (b.issues.length) return <ul>{b.issues.map((r) => <Issue key={r.key} r={r} />)}</ul>
  return <span className="text-muted">{checked === 'loading' ? 'Checking…' : checked ? none || 'none open' : 'not checked: feed unavailable'}</span>
}

// One table. The owner does not use Overview on a phone (2026-11-09), so a
// narrow screen scrolls the table inside its own box rather than getting a
// second layout.
//
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

// "DNS 1 warning, 1 note · IPAM 1 critical", or "no open issues".
function boardSummary(rows) {
  const parts = rows
    .map((b) => {
      const n = (sev) => b.issues.filter((r) => r.sev === sev).length
      const words = [['crit', 'critical'], ['warn', 'warning'], ['note', 'note']]
        .filter(([sev]) => n(sev))
        .map(([sev, w]) => `${n(sev)} ${w}${n(sev) > 1 && sev !== 'crit' ? 's' : ''}`)
      return words.length ? `${b.name} ${words.join(', ')}` : null
    })
    .filter(Boolean)
  return parts.length ? parts.join(' · ') : 'no open issues'
}

function ServiceBoard({ board }) {
  const [hidden, setHidden] = useState(readHidden)
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
    <section aria-labelledby="ov-board">
      <div className="flex items-baseline gap-3 mb-1">
        <h2 id="ov-board" className="text-copy font-semibold">Services</h2>
        <button type="button" onClick={toggle} aria-expanded={!hidden} aria-controls="ov-board-table" className={`text-copy text-link underline ${FOCUS_RING}`}>
          {hidden ? 'Show' : 'Hide'}
        </button>
        {hidden && <span className="text-copy text-muted min-w-0" data-board-summary="">{boardSummary(board.board)}</span>}
      </div>
      <div id="ov-board-table" hidden={hidden} role="region" aria-label="Service board" tabIndex={0} className={`overflow-x-auto ${FOCUS_RING}`}>
      <table className="w-full min-w-[760px] text-copy border-t border-line" data-board="">
        <thead className="text-muted text-left">
          <tr>
            {['Service', 'Open issues', 'Measure', 'Last 24h', 'Service health'].map((h) => (
              <th key={h} scope="col" className="font-normal py-2 pr-4 border-b border-line">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {board.board.map((b) => (
            <tr key={b.name} data-board-row={b.name} className="border-b border-line align-top">
              <th scope="row" className="text-left py-2.5 pr-4 font-semibold whitespace-nowrap"><a href={b.href} className={`hover:underline ${FOCUS_RING}`}>{b.name}</a></th>
              <td className="py-2.5 pr-4 w-[48%]"><IssueList b={b} checked={board.issuesChecked[b.name]} none={board.noneLabel[b.name]} /></td>
              <td className="py-2.5 pr-4 tabular-nums">{b.measure}<span className="block text-muted">{b.scope || '\u00a0'}</span></td>
              <td className="py-2.5 pr-4">{b.trend ? <Spark rows={b.trend} /> : <span className="text-muted">—</span>}</td>
              <td className="py-2.5 pr-4"><StateCell state={b.state} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
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
              <span className="text-note" style={{ color: flat ? COLORS.other : delta >= 0 ? COLORS.ok : COLORS.crit }}>
                {flat ? '— flat' : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}%`} vs first hour
              </span>
            )}
          </div>
          {/* The headline above this chart already rounds the same series to
              one decimal; the tooltip used to answer `value : 346.1144444444444`
              for the very same point. One decimal, and the unit spelled out. */}
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
        </>
      )}
    </Card>
  )
}


// ---------- host status buckets ----------

// "unknown" is the backend's word (go/internal/dashboard/norm.go) for a host
// whose upstream status was absent or unrecognised — deliberately not the real
// lifecycle state "pending" it used to masquerade as. It is its own bucket, not
// part of Other: "we do not know this host's state" is a fact an operator acts
// on, and folding it into a catch-all made this donut disagree with Infra's
// (Unknown 2% / Other 8% there vs a single Other 10% here) about the same hosts.
//
// Mirrors statusBucket() / BUCKET_LABEL / the bucket order in ui/src/tabs/
// Infra.jsx, which does not export them. Keep the two in step: same names, same
// order, same colours, so the two screens read as one number.
function statusBucket(s) {
  s = s || ''
  if (/^unknown$/i.test(s)) return 'unknown'
  if (/online|up|active/i.test(s)) return 'active'
  if (/degraded|warn/i.test(s)) return 'degraded'
  if (/off|down|error|fail/i.test(s)) return 'offline'
  return 'other'
}
