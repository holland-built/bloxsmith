import { lazy, Suspense, useMemo, useState } from 'react'
import { useApi } from '../lib/api.js'
import { useData } from '../lib/data.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, hiddenPanelGroup, Skeleton, useChartTheme } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { dnssecPanelLabel, fmtShortDay } from '../lib/chartFormat.js'
import { useHashParams } from '../lib/hash.js'
import { SERVICE_GROUPS, useOwnedServices } from '../lib/services.js'
import { useThemeColors } from '../lib/theme.jsx'

// ---------- main ----------

// The only /api/data slice this tab shows. See Audit.jsx for why the list is
// declared rather than inferred: the accessors refuse to answer for anything
// not named here, so an unrequested slice can never be rendered as empty or as
// broken. (zones pulls dnsViews server-side to resolve view names; that is the
// server's dependency closure, not something this tab reads.)
const SLICES = ['zones']

// Both charts on this tab share one shape; only they wait for recharts.
const GradientArea = lazy(() => import('../charts/GradientArea.jsx'))

export default function Dns() {
  const qps = useApi('/api/csp/dns-qps', { poll: 30000 })
  const services = useApi('/api/csp/dns-services', { poll: 30000 })
  // Re-enabled 2026-07-22: MCP calls now carry a bounded 12s deadline (mcp.go post()),
  // so a stalled feed errors out instead of hanging goroutines / starving the upstream.
  const analytics = useApi('/api/dns-analytics', { poll: 30000 })
  const data = useData(SLICES, { poll: 30000 })
  const dnssec = useApi('/api/csp/dnssec', { poll: 30000 })
  const rpz = useApi('/api/csp/rpz', { poll: 30000 })
  const dtcLbdn = useApi('/api/csp/dtc-lbdn', { poll: 30000 })

  const hp = useHashParams()
  // One shared read of /api/service-inventory per page load — see Security.jsx:
  // deliberately not useApi(), so it never joins the 30s poll above.
  const owned = useOwnedServices()
  const zones = data.rows('zones')
  // 'ok' | 'empty' | 'error' — 'error' also when the payload arrived without
  // the zones slice, because that read did not deliver.
  const zonesStatus = data.status('zones')

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-copy font-semibold tracking-tight mb-3">DNS</h1>
      {/* Every direct child of a grid with a layoutKey carries its own panelId:
          CardGrid applies the saved order to its React children by reading
          `props.panelId` off them, while it reads the live order off the DOM. A
          wrapper whose id only exists on the <Card> inside it is visible to the
          second and invisible to the first, and the panel jumps to the end on
          reload. Each wrapper below forwards the id to its Card. */}
      <CardGrid layoutKey="dns">
        {/* Two separate runs, one group key: the panels either side of
            ZoneKpis both need a deployed DNS service, but ZoneKpis reads zone
            CONFIG, which exists whether or not one is deployed — so it is not
            mapped and cannot be swept into the group. */}
        {hiddenPanelGroup({
          ...SERVICE_GROUPS.dns,
          state: owned,
          children: [<QpsHero key="dns-query-rate" panelId="dns-query-rate" qps={qps} />],
        })}
        {/* The id sits on the call site, not on the Cards inside: ZoneKpis
            returns a different Card for loading / dead feed / data, and all
            three are the same panel. One literal id, forwarded to whichever
            Card renders — see panelHelp.test.js on the wrapper pattern. */}
        <ZoneKpis panelId="dns-zone-kpis" zones={zones} zonesStatus={zonesStatus} loading={data.loading} />
        {hiddenPanelGroup({
          ...SERVICE_GROUPS.dns,
          state: owned,
          children: [<DnsServices key="dns-services" panelId="dns-services" services={services} />],
        })}
        <QueryVolume7d panelId="dns-query-volume-7d" analytics={analytics} />
        <ZoneTable panelId="dns-zones" zones={zones} issuesOnly={!!hp.issues} zonesStatus={zonesStatus} loading={data.loading} />
        <DnssecHealth panelId="dns-dnssec-health" dnssec={dnssec} />
        <RpzPanel panelId="dns-rpz" rpz={rpz} />
        <DtcLbdnPanel panelId="dns-dtc-lbdn" dtcLbdn={dtcLbdn} />
      </CardGrid>
    </div>
  )
}

// ---------- hero ----------

function QpsHero({ panelId, qps }) {
  const { COLORS } = useChartTheme()
  const rows = qps.data?.rows ?? []
  const status = qps.data?.status
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
      title="DNS Query Rate — 24h"
      right={<span className="flex items-center gap-1.5 text-note text-muted"><i className="w-2 h-2 rounded-mark inline-block" style={{ background: COLORS.accent }} />avg qps</span>}
    >
      {qps.loading ? (
        <Skeleton h={250} />
      ) : qps.error || status === 'error' ? (
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
          {/* The big number above this chart already rounds to one decimal;
              the hover used to disagree with it by ten digits (`value :
              274.715`). Same series, same rounding, and the unit said out
              loud — the point labels are already clock times ("03:00 PM"),
              which fmtShortDay hands back untouched. */}
          <Suspense fallback={<Skeleton h={230} />}>
            <GradientArea
              data={chartData}
              color={COLORS.accent}
              gradientId="qpsFill"
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

// ---------- zone ttl ----------
//
// A zone whose upstream carries no zone_authority publishes no TTL at all, so
// the backend emits ttl/neg_ttl as null and skips the TTL health checks for it
// (issues/anomaly stay null) rather than fabricating 3600 and declaring the
// zone healthy. The UI has to keep that distinction: an unknown TTL is not a
// value, so it is not a number, not a zero, and not a clean result.

/** Numeric TTL, or null when the zone never published one. */
function ttlValue(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** True when this zone was actually run through the TTL checks. */
function ttlChecked(z) {
  return Array.isArray(z.issues)
}

// Sort by TTL with unknowns last in BOTH directions. `Number(null) || 0` used
// to file every unknown-TTL zone at the very front of an ascending sort, right
// among the genuinely dangerous 30-second zones.
function ttlCompare(a, b, dir) {
  const av = ttlValue(a.ttl)
  const bv = ttlValue(b.ttl)
  if (av == null || bv == null) return av == null && bv == null ? 0 : av == null ? 1 : -1
  return dir === 'asc' ? av - bv : bv - av
}

// ---------- zone kpis ----------

function ZoneKpis({ panelId, zones, zonesStatus, loading }) {
  const { COLORS } = useChartTheme()
  // A load in flight is not a verdict. Without this the panel would print
  // three confident zeros (before) or a feed-unavailable notice (now that an
  // unarrived slice reads as 'error') for a read that simply has not finished.
  if (loading) {
    return (
      <Card panelId={panelId} span={2} panelName="Zone Counts" className="flex flex-col justify-between">
        <Skeleton h={200} />
      </Card>
    )
  }
  // All three cells read the same `zones` feed — a dead read means none of
  // these counts are known, not that they're all zero.
  if (zones.length === 0 && zonesStatus === 'error') {
    return (
      <Card panelId={panelId} span={2} panelName="Zone Counts" className="flex flex-col justify-between">
        <FeedUnavailable label="DNS zones feed unavailable" />
      </Card>
    )
  }

  const issueCount = zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0).length
  const anomalyCount = zones.filter((z) => z.anomaly).length
  // Zones with no published TTL were never run through the checks. They are
  // not clean zones — they are unexamined ones, so "3 of N have issues" would
  // be a claim about zones that were never all looked at. Both verdict tiles
  // therefore name the population they actually cover. On the live tenant
  // today every zone reports a TTL, so the coverage note stays hidden.
  const checked = zones.filter(ttlChecked).length
  const unchecked = zones.length - checked
  const coverage = unchecked > 0 ? `of ${checked.toLocaleString()} checked` : null

  const cells = [
    {
      label: 'Zones',
      value: zones.length.toLocaleString(),
      note: unchecked > 0 ? `${unchecked.toLocaleString()} publish no TTL` : null,
    },
    {
      label: 'Zones w/ issues',
      value: issueCount.toLocaleString(),
      color: issueCount > 0 ? COLORS.crit : COLORS.accent,
      note: coverage,
    },
    {
      label: 'Anomalies',
      value: anomalyCount.toLocaleString(),
      color: anomalyCount > 0 ? COLORS.warn : COLORS.accent,
      note: coverage,
    },
  ]

  return (
    // All three branches of this component are the SAME panel and carry the
    // same `panelName`: they are the loading, the dead-feed and the data views
    // of one tile, so the popup must call it one thing whichever is on screen.
    // It draws no heading — the cells are their own labels — which is why it
    // used to be listed as "dns-zone-kpis".
    <Card panelId={panelId} span={2} panelName="Zone Counts" className="flex flex-col justify-between">
      {cells.map((c, i) => (
        <div key={c.label} className={`py-3.5 ${i < cells.length - 1 ? 'border-b border-line-2' : ''}`}>
          <div className="text-muted text-note">{c.label}</div>
          <div className="text-figure font-semibold tracking-tight my-1" style={{ color: c.color }}>{c.value}</div>
          {c.note && <div className="text-dim text-note leading-tight">{c.note}</div>}
        </div>
      ))}
    </Card>
  )
}

// ---------- dns services ----------

function DnsServices({ panelId, services }) {
  const rows = services.data?.rows ?? []
  const status = services.data?.status

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'comment', label: 'Comment', grow: true },
    { key: 'pool_id', label: 'Pool ID', mono: true },
  ]

  return (
    <Card panelId={panelId} span={3} title="DNS Services" right={<span className="text-note text-muted">{rows.length ? `${rows.length} services` : ''}</span>}>
      {services.loading ? (
        <Skeleton h={180} />
      ) : services.error || status === 'error' ? (
        <FeedUnavailable label="DNS services feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <DataTable rows={rows} columns={columns} maxHeight={320} rowKey={(r, i) => `${r.id ?? ''}|${i}`} />
      )}
    </Card>
  )
}

// ---------- query volume 7d (known-broken feed) ----------

function QueryVolume7d({ panelId, analytics }) {
  const { COLORS } = useChartTheme()
  // dns-analytics can legitimately return zero rows for a tenant with no query
  // activity — that must render as empty, not as a dead feed. Only a fetch
  // error or an explicit availability:"error" from the backend (a dead
  // cubejs) counts as broken; a genuinely empty "ok" fetch does not.
  const volume = analytics.data?.volume ?? []
  const broken = !!analytics.error || analytics.data?.availability === 'error'
  // `r.hour ?? i` was reading a field these rows have never carried. Verified
  // against the live feed on 2026-08-07: each row is
  // {timestamp, "timestamp.day", total_query_count} — no `hour` anywhere, so
  // every label fell through to the array index and this chart spent its life
  // labelling seven days of traffic 0,1,2,3,4,5,6 on the axis AND in the hover.
  // `hour` stays in the chain because the qps feed does use that name and this
  // panel is the one that would inherit it if the two were ever merged.
  const chartData = volume.map((r, i) => ({
    label: r.timestamp ?? r.hour ?? i,
    value: Number(r.total_query_count) || 0,
  }))

  return (
    <Card panelId={panelId} span={3} title="Query Volume — 7d" note={broken ? 'feed unavailable' : undefined}>
      {analytics.loading ? (
        <Skeleton h={180} />
      ) : broken ? (
        <Empty>no data</Empty>
      ) : (
        /* The label is now the day itself, so both the axis and the hover
           have to spell it — an ISO timestamp on the axis would just be a
           different kind of unreadable than the index it replaced. */
        <Suspense fallback={<Skeleton h={200} />}>
          <GradientArea
            data={chartData}
            color={COLORS.purple}
            gradientId="volFill"
            unit="queries"
            height={200}
            tickFormat={fmtShortDay}
          />
        </Suspense>
      )}
    </Card>
  )
}

// ---------- zone table ----------

function ZoneTable({ panelId, zones, issuesOnly, zonesStatus, loading }) {
  const { COLORS } = useChartTheme()
  const theme = useThemeColors()
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState({ key: 'fqdn', dir: 'asc' })

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let base = issuesOnly ? zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0) : zones
    if (!q) return base
    return base.filter((z) => [z.fqdn, z.view].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [zones, filter, issuesOnly])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    arr.sort((a, b) => {
      // TTL has a third outcome — unknown — so it cannot go through the
      // number branch below, which would rank it as 0.
      if (key === 'ttl') return ttlCompare(a, b, dir)
      let av, bv
      if (key === 'fqdn') { av = a.fqdn || ''; bv = b.fqdn || '' }
      else if (key === 'view') { av = a.view || ''; bv = b.view || '' }
      else if (key === 'records') { av = Number(a.records) || 0; bv = Number(b.records) || 0 }
      else if (key === 'issues') { av = (a.issues?.length) || 0; bv = (b.issues?.length) || 0 }
      else { av = a.fqdn || ''; bv = b.fqdn || '' }
      if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return dir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [filtered, sort])

  // Map zone objects -> DataTable rows. `records` is a formatted string and `issues`
  // is the crit text / anomaly pill node (or '—') so the primitive's hideWhenConstant
  // can auto-drop them when every value is "0" / "—" respectively.
  const rows = useMemo(() => sorted.map((z) => {
    const hasIssues = Array.isArray(z.issues) && z.issues.length > 0
    const issuesCell = hasIssues ? (
      <span className="font-mono text-note" style={{ color: COLORS.crit }}>{z.issues.join(', ')}</span>
    ) : z.anomaly ? (
      <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: 'var(--pill-warn-bg)', color: 'var(--pill-warn-fg)' }}>anomaly</span>
    ) : ttlChecked(z) ? '—' : (
      // Distinct from the clean '—': this zone published no TTL, so the checks
      // never ran on it. Silence here would read as "checked, nothing wrong".
      <span className="text-note italic text-dim" title="no TTL published — TTL checks did not run for this zone">not checked</span>
    )
    const ttl = ttlValue(z.ttl)
    return {
      fqdn: z.fqdn,
      view: z.view,
      records: (Number(z.records) || 0).toLocaleString(),
      // No TTL published => em-dash, never a number this zone does not have.
      ttl: ttl == null ? '—' : ttl,
      issues: issuesCell,
      _hasIssues: hasIssues,
    }
  }), [sorted, COLORS])

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, keep: true, grow: true, sortable: true },
    { key: 'view', label: 'View', sortable: true },
    { key: 'records', label: 'Records', align: 'right', hideWhenConstant: true, sortable: true },
    // keep: DataTable auto-hides a column whose every cell is empty, and '—' is
    // an empty cell to it. A view where no zone publishes a TTL must still show
    // the TTL column full of dashes — silently dropping it reads as "TTL isn't
    // tracked" instead of "we don't know it".
    { key: 'ttl', label: 'TTL', mono: true, sortable: true, keep: true },
    { key: 'issues', label: 'Issues', hideWhenConstant: true, sortable: true },
  ]

  return (
    <Card
      panelId={panelId}
      span={6}
      // The heading becomes a React node the moment the issues-only filter is
      // on, so without this the popup's row for this panel flipped between
      // "DNS Zones" and the raw "dns-zones" depending on how the tab was
      // filtered. The name is the heading's constant half.
      panelName="DNS Zones"
      title={
        issuesOnly ? (
          <span className="inline-flex items-center gap-2">
            DNS Zones
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => { location.hash = 'dns' }}
              className="text-note font-medium px-2 py-0.5 rounded-full cursor-pointer"
              style={{ background: theme.pillNeutralBg, color: theme.pillNeutralFg }}
            >
              issues only ✕
            </button>
          </span>
        ) : 'DNS Zones'
      }
      right={
        <div className="flex items-center gap-2.5">
          <span className="text-note text-muted whitespace-nowrap">{sorted.length.toLocaleString()} zones</span>
          <input
            aria-label="Filter zones"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${FIELD_CLS} w-[170px]`}
          />
        </div>
      }
    >
      {loading ? (
        // Same reason as ZoneKpis: an unfinished read is neither "no zones"
        // nor "the feed is dead".
        <Skeleton h={250} />
      ) : zones.length === 0 ? (
        zonesStatus === 'error' ? <FeedUnavailable label="DNS zones feed unavailable" /> : <Empty />
      ) : sorted.length === 0 ? (
        <Empty>no zones match</Empty>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          sort={sort}
          onSort={setSort}
          maxHeight={420}
          rowCap={150}
          stickyHeader
          rowKey={(r, i) => (r.fqdn || '') + i}
          rowStyle={(r) => (r._hasIssues ? { background: 'rgba(238,68,68,0.06)' } : undefined)}
        />
      )}
    </Card>
  )
}

// ---------- dnssec health ----------

const DNSSEC_CAP = 150

function DnssecHealth({ panelId, dnssec }) {
  const { COLORS } = useChartTheme()
  const rows = dnssec.data?.rows ?? []
  const total = dnssec.data?.count ?? rows.length
  // CSPDnssec returns status:"error" at HTTP 200 on an upstream failure — the
  // fetch itself never errors, so `dnssec.error` alone never catches this.
  const status = dnssec.data?.status

  const signedCount = rows.filter((r) => r.dnssec_status === 'SIGNED').length
  const unsignedCount = rows.filter((r) => r.dnssec_status === 'UNSIGNED').length
  const signedShare = rows.length ? (signedCount / rows.length) * 100 : null

  // This panel used to say "worst 150" over `unsigned.slice(0, DNSSEC_CAP)` of
  // whatever order the upstream happened to return. Checked the live payload on
  // 2026-08-07: a row carries fqdn, view, id, dnssec_status and
  // dnssec_signing_policy, and nothing else. There is no severity, no age, no
  // record count — nothing that ranks one unsigned zone above another, so
  // "worst" was a claim the data cannot make and the cut was also non-repeatable
  // between reloads. Sorting A–Z cannot invent severity, but it does make the
  // 150 you see the same 150 every time, and the header now says which 150 they
  // are. If the upstream ever adds a real severity field, sort by that instead
  // and the header should say so.
  const unsigned = rows
    .filter((r) => r.dnssec_status === 'UNSIGNED')
    .sort((a, b) => String(a.fqdn ?? '').localeCompare(String(b.fqdn ?? '')))
  const shown = unsigned.slice(0, DNSSEC_CAP)

  const tableRows = shown.map((r, i) => ({
    fqdn: r.fqdn,
    view: r.view,
    dnssec_status: r.dnssec_status,
    dnssec_signing_policy: r.dnssec_signing_policy || '—',
    _k: `${r.fqdn ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, grow: true },
    { key: 'view', label: 'View', mono: true, maxCh: 22 }, // measured: opaque resource path overflows the card; cap it
    { key: 'dnssec_signing_policy', label: 'Signing Policy' },
  ]

  return (
    <Card
      panelId={panelId}
      span={3}
      title="DNSSEC Health"
      right={
        <span className="text-note text-muted">{dnssecPanelLabel(unsigned.length, DNSSEC_CAP)}</span>
      }
    >
      {dnssec.loading ? (
        <Skeleton h={280} />
      ) : dnssec.error || status === 'error' ? (
        <FeedUnavailable label="DNSSEC feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no DNSSEC data</Empty>
      ) : (
        <>
          <div className="flex items-center gap-4 my-2">
            <div>
              <div className="text-figure font-semibold tracking-tight" style={{ color: COLORS.ok }}>{signedCount.toLocaleString()}</div>
              <div className="text-note text-muted">signed</div>
            </div>
            <div>
              <div className="text-figure font-semibold tracking-tight" style={{ color: unsignedCount > 0 ? COLORS.crit : COLORS.ok }}>{unsignedCount.toLocaleString()}</div>
              <div className="text-note text-muted">unsigned</div>
            </div>
            {signedShare != null && (
              <div>
                <div className="text-figure font-semibold tracking-tight">{signedShare.toFixed(1)}%</div>
                <div className="text-note text-muted">signed share (of {total.toLocaleString()})</div>
              </div>
            )}
          </div>
          {unsigned.length === 0 ? (
            <Empty>all zones signed</Empty>
          ) : (
            <DataTable rows={tableRows} columns={columns} maxHeight={260} rowCap={DNSSEC_CAP} rowKey={(r) => r._k} />
          )}
        </>
      )}
    </Card>
  )
}

// ---------- rpz policy zones ----------

function RpzPanel({ panelId, rpz }) {
  const rows = rpz.data?.rows ?? []
  const total = rpz.data?.count ?? rows.length
  // Same errRows() contract as DnssecHealth — status:"error" at HTTP 200.
  const status = rpz.data?.status

  const tableRows = rows.map((r, i) => ({
    fqdn: r.fqdn,
    severity: r.severity || '—',
    policy_override: r.policy_override || '—',
    type: r.type || '—',
    disabled: r.disabled ? 'Disabled' : 'Enabled',
    _k: `${r.fqdn ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, grow: true },
    { key: 'severity', label: 'Severity' },
    { key: 'policy_override', label: 'Policy Override' },
    { key: 'type', label: 'Type' },
    { key: 'disabled', label: 'Status' },
  ]

  return (
    <Card panelId={panelId} span={3} title="RPZ Policy Zones" right={<span className="text-note text-muted">{rows.length ? `${total.toLocaleString()} zones` : ''}</span>}>
      {rpz.loading ? (
        <Skeleton h={200} />
      ) : rpz.error || status === 'error' ? (
        <FeedUnavailable label="RPZ feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no RPZ zones</Empty>
      ) : (
        <DataTable rows={tableRows} columns={columns} maxHeight={260} rowKey={(r) => r._k} />
      )}
    </Card>
  )
}

// ---------- dtc load-balanced names ----------

function DtcLbdnPanel({ panelId, dtcLbdn }) {
  const rows = dtcLbdn.data?.rows ?? []
  const total = dtcLbdn.data?.count ?? rows.length
  // Same errRows() contract as DnssecHealth/RpzPanel — status:"error" at HTTP 200.
  const status = dtcLbdn.data?.status

  const tableRows = rows.map((r, i) => ({
    name: r.name,
    dtc_policy: r.dtc_policy || '—',
    precedence: r.precedence,
    ttl: r.ttl,
    disabled: r.disabled ? 'Disabled' : 'Enabled',
    _k: `${r.name ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'name', label: 'Name', mono: true, grow: true },
    { key: 'dtc_policy', label: 'Policy' },
    { key: 'precedence', label: 'Precedence', align: 'right' },
    { key: 'ttl', label: 'TTL', mono: true, align: 'right' },
    { key: 'disabled', label: 'Status' },
  ]

  return (
    <Card panelId={panelId} span={3} title="DTC Load-Balanced Names" right={<span className="text-note text-muted">{rows.length ? `${total.toLocaleString()} names` : ''}</span>}>
      {dtcLbdn.loading ? (
        <Skeleton h={200} />
      ) : dtcLbdn.error || status === 'error' ? (
        <FeedUnavailable label="DTC LBDN feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no LBDN records</Empty>
      ) : (
        <DataTable rows={tableRows} columns={columns} maxHeight={260} rowKey={(r) => r._k} />
      )}
    </Card>
  )
}
