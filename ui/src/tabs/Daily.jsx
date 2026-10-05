import { useMemo } from 'react'
import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, FOCUS_RING, Skeleton, utilStatus } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useApi } from '../lib/api.js'
import { sliceState } from '../lib/data.js'
import { sampleCountLabel, sampleScopeNote } from '../lib/sampleCount.js'
import { cmpMaybe, DASH, freeOf, num } from '../lib/measured.js'
import { UTIL_CRIT, utilBand } from '../lib/utilBands.js'

// Per-slice status for a RAW useApi('/api/data') read.
//
// This tab reads the route directly, so it does not get the honesty rule that
// ui/src/lib/data.js applies for useData() tabs. Without it, a request that
// fails outright (a 500, or the cold-request abort) leaves data.data null =>
// _meta {} => the slice status undefined => every `=== 'error'` branch below
// falls through to <Empty/> — "all hosts online", "no DNS zone issues" — for a
// read that never happened. Same rule as lib/data.js: requested but missing =>
// 'error', whether the whole request died or the payload came back without the
// slice.
//
// The vocabulary stays exactly ok / empty / error. A first read still in flight
// is not a verdict at all — it returns undefined so the panel keeps its
// skeleton rather than accusing the feed.
function feedStatus(api, name) {
  if (api.loading && !api.data) return undefined
  if (api.error || !api.data) return 'error'
  return sliceState(api.data, name).status
}

// ---------- main ----------

// The briefing look: panels sit on the page itself, divided by a hairline rule
// above each one, with no card box around them. Security Today is the one
// filled panel, so the only box on the page is the one sample-based panel.
const OPEN = 'bg-transparent! border-0! border-t! border-line! px-0! pt-4!'
const FILLED = 'bg-line/40! border-0!'

export default function Daily() {
  const data = useApi('/api/data', { poll: 30000 })
  const sec = useApi('/api/hub/security', { poll: 30000 })

  const subnets = data.data?.subnets ?? []
  const hosts = data.data?.hosts ?? []
  const zones = data.data?.zones ?? []
  const totals = data.data?._totals
  // Each panel reads a DIFFERENT slice, so the status is per-slice — but a
  // failure of the whole request is a failure of all three.
  const meta = {
    subnets: feedStatus(data, 'subnets'),
    hosts: feedStatus(data, 'hosts'),
    zones: feedStatus(data, 'zones'),
  }
  // When this page last received /api/data, not the time on the clock: a
  // stalled poll must not keep claiming the figures are fresh.
  // The whole refresh failed and useApi is still holding the previous read.
  // Not the same as a slice reporting 'error': the backend can send current
  // rows for a slice it only read in part, and those are not old.
  const stale = !!data.error && !!data.data
  const asOf = useMemo(() => (data.data ? new Date() : null), [data.data])

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-figure font-semibold tracking-tight mb-1">Daily Briefing</h1>
      <p className="text-muted mb-4">
        {asOf
          ? `Open items as of ${asOf.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, refreshed every 30 seconds.`
          : 'Loading open items.'}
      </p>
      {/* The panelIds sit on the call sites, not only on the Card each wrapper
          returns: CardGrid reads panelId off its OWN direct children to apply a
          saved order, and a wrapper that keeps the id inside is invisible to
          that read. Each wrapper forwards it to its Card unchanged. */}
      <CardGrid layoutKey="daily" className="gap-x-8! gap-y-6!">
        <IssueKpis panelId="daily-open-issues" subnets={subnets} hosts={hosts} zones={zones} totals={totals} meta={meta} loading={data.loading} />
        <SecurityToday panelId="daily-security-today" sec={sec} />
        <TopCapacityRisks panelId="daily-top-capacity-risks" subnets={subnets} loading={data.loading} subnetsStatus={meta.subnets} stale={stale} />
        <HostsAttention panelId="daily-hosts-attention" hosts={hosts} loading={data.loading} hostsStatus={meta.hosts} stale={stale} />
        <DnsZoneIssues panelId="daily-dns-zone-issues" zones={zones} loading={data.loading} zonesStatus={meta.zones} stale={stale} />
      </CardGrid>
    </div>
  )
}

// ---------- KPI cards ----------

function IssueKpis({ subnets, hosts, zones, meta = {}, loading, panelId }) {
  const { COLORS } = useChartTheme()
  // `subnets` (data.subnets) is the union of the first-5,000 page and every
  // subnet with util >= 70, deduped. That union is COMPLETE for any threshold
  // >= 70 — a subnet in the red band is necessarily >= 70, so it cannot be
  // missing from the union. Counting rows here is therefore an exact
  // whole-network figure for this tile, not a coverage-set sample.
  //
  // NOT `_totals.subnetsCrit`, though it is the same threshold since
  // 2026-10-04 (this tile counted from 85 until then): that total includes the
  // /29-/32 infra links, and this count leaves them out.
  //
  // The red band is inclusive at its lower edge (lib/utilBands.js), which
  // agrees with the drill-down this row links to: Network.jsx keeps
  // `u >= minUtil`. The `<= 28` rule mirrors that same drill-down (Network.jsx
  // `base`), which drops /29-/32 infra links; it is disclosed in the help copy
  // for this panel.
  const critSubnets = subnets.filter((s) => (Number(s.cidr) || 0) <= 28 && utilBand(Number(s.util) || 0) === 'crit')
  const badHosts = hosts.filter((h) => !/online|active/i.test(h.status || ''))
  const zonesWithIssues = zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0)

  // The line under each number says what is behind it, from the same rows the
  // number counts.
  const byStatus = {}
  for (const h of badHosts) {
    const k = (h.status || 'unknown').toLowerCase()
    byStatus[k] = (byStatus[k] || 0) + 1
  }
  const issueTypes = {}
  for (const z of zonesWithIssues) for (const t of z.issues) issueTypes[t] = (issueTypes[t] || 0) + 1
  const commonTypes = Object.entries(issueTypes).sort((a, b) => b[1] - a[1]).slice(0, 3)

  // Each KPI reads a DIFFERENT feed (subnets/hosts/zones) — one can be dead
  // while the other two are fine, so the gate is per-row, not per-card.
  const cells = [
    {
      label: `Subnets ≥${UTIL_CRIT}% Util`, value: critSubnets.length, color: COLORS.crit, hash: `network?minUtil=${UTIL_CRIT}`, status: meta.subnets,
      detail: '/29–/32 links are left out.',
    },
    {
      label: 'Hosts Not Online', value: badHosts.length, color: COLORS.warn, hash: 'infra?status=not-online', status: meta.hosts,
      detail: `${hosts.length.toLocaleString()} hosts loaded.` +
        (badHosts.length ? ' ' + Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(', ') + '.' : ''),
    },
    {
      label: 'DNS Zones w/ Issues', value: zonesWithIssues.length, color: COLORS.warn, hash: 'dns?issues=1', status: meta.zones,
      detail: commonTypes.length ? `Most common: ${commonTypes.map(([t, n]) => `${t} (${n.toLocaleString()})`).join(', ')}.` : '',
    },
  ]

  return (
    <Card span={4} panelId={panelId} title="Open Issues" note="what needs you this morning" className={OPEN}>
      {loading ? (
        <Skeleton h={160} />
      ) : (
        cells.map((c) => {
          const unavailable = c.status === 'error'
          // The label's parent is the row, and it holds the number too: the
          // failure tests find a row by its label and look for the value beside it.
          return (
            <div
              key={c.label}
              role="button"
              tabIndex={0}
              onClick={() => { location.hash = c.hash }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = c.hash } }}
              className={`grid grid-cols-[6rem_1fr] items-baseline gap-x-4 py-3 border-b border-line last:border-b-0 cursor-pointer hover:bg-line/50 ${FOCUS_RING}`}
            >
              {unavailable ? (
                <div className="row-span-2 text-note font-semibold text-right" style={{ color: COLORS.crit }}>unavailable</div>
              ) : (
                <div className="row-span-2 text-figure font-semibold tracking-tight tabular-nums text-right" style={{ color: c.value > 0 ? c.color : undefined }}>
                  {c.value.toLocaleString()}
                </div>
              )}
              <div className="text-copy font-semibold">{c.label}</div>
              <div className="col-start-2 text-note text-muted mt-0.5">{unavailable ? 'This feed did not answer.' : c.detail}</div>
            </div>
          )
        })
      )}
    </Card>
  )
}

// ---------- security today ----------

function SecurityToday({ sec, panelId }) {
  const { COLORS } = useChartTheme()
  const counts = sec.data?.counts ?? {}
  // No `events` binding any more. This panel only ever read its LENGTH, to print
  // it as the hour's event count, and that is the number issue #157 was about:
  // the server's `returned` and `truncated` are what the heading is built from
  // now, so counting the rows here would just be the old answer arrived at a
  // second way.
  const chips = [
    { label: 'critical', value: Number(counts.critical) || 0, color: COLORS.crit },
    { label: 'high', value: Number(counts.high) || 0, color: COLORS.warn },
    { label: 'medium', value: Number(counts.medium) || 0, color: COLORS.other },
    { label: 'low', value: Number(counts.low) || 0 },
    { label: 'blocked', value: Number(sec.data?.blocked) || 0, color: COLORS.ok },
    { label: 'logged', value: Number(sec.data?.logged) || 0 },
  ]

  // A dead threat feed is not a quiet day. The fetch failing, or finishing with
  // no body at all, is the same "we do not know" as an explicit
  // availability:"error" — never four zeros and "0 events".
  const secDead = !sec.loading && (!!sec.error || !sec.data || sec.data.availability === 'error')

  // The four chips are counted from the rows the server had in hand, and until
  // 2026-08-20 nothing said so: the feed is fetched with a row limit, and on a
  // busy hour "blocked 50" meant "all 50 rows I looked at were blocked", not
  // "50 threats blocked this hour". Measured live that day, the cap was being
  // hit. The heading now names the sample and this line names its scope.
  const scopeNote = sampleScopeNote(sec.data, 'events')

  return (
    <Card
      span={2}
      panelId={panelId}
      title="Security Today"
      className={FILLED}
      right={<span className="text-note text-muted">{sec.loading || secDead ? '— events' : sampleCountLabel(sec.data, 'events')}</span>}
    >
      {sec.loading ? (
        <Skeleton h={160} />
      ) : secDead ? (
        <FeedUnavailable reason={sec.data?.reason} label="Threat feed unavailable" />
      ) : (
        <>
          <dl className="divide-y divide-line">
            {chips.map((c) => (
              <div key={c.label} className="flex justify-between py-1.5">
                <dt className="text-muted capitalize">{c.label}</dt>
                <dd className="font-semibold tabular-nums" style={{ color: c.value > 0 ? c.color : undefined }}>
                  {c.value.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
          {scopeNote && <div className="text-note text-dim mt-2">{scopeNote}</div>}
        </>
      )}
    </Card>
  )
}

// ---------- top capacity risks ----------

// A refresh that fails after a good one leaves the last rows in place (useApi
// keeps its data on error). Those rows are still worth seeing, but not as if
// they were current: Open Issues already says "unavailable" for the same feed.
function StaleNote() {
  return <p className="text-note text-warn mb-2">The last refresh failed. These rows are from the previous read.</p>
}

function TopCapacityRisks({ subnets, loading, subnetsStatus, stale, panelId }) {
  const feedDead = subnetsStatus === 'error' && subnets.length === 0
  const rows = [...subnets]
    .filter((s) => (s.addr || s.cidr) && (Number(s.cidr) || 0) <= 28)
    .map((s) => ({
      ...s,
      network: s.addr || s.cidr,
      // null when the row reported no figure. `Number(x) || 0` used to turn
      // that into 0% used with 0 free, which is the TOP of a list ranked by
      // least free space, under a Healthy pill: the subnet nobody measured,
      // shown as the worst one and as fine at once.
      util: num(s.util),
      free: freeOf(s),
    }))
    // Unmeasured last. A subnet with no figure is not the one with least room.
    .sort((a, b) => cmpMaybe(a.free, b.free, 'asc'))

  const columns = [
    { key: 'network', label: 'Network', mono: true },
    { key: 'site', label: 'Site', keep: true },
    {
      key: 'util',
      label: 'Util',
      keep: true,
      render: (v) => {
        // utilStatus(null) would answer Healthy. Not measured is its own word.
        const st = v === null ? { bg: 'var(--pill-neutral-bg)', fg: 'var(--pill-neutral-fg)' } : utilStatus(v)
        return (
          <span className="inline-block rounded-full px-2 py-0.5 text-note font-medium" style={{ background: st.bg, color: st.fg }}>
            {v === null ? 'Unknown' : `${v}%`}
          </span>
        )
      },
    },
    { key: 'used', label: 'Used', align: 'right', render: (v, s) => <span className="text-muted tabular-nums">{num(v) === null || num(s.total) === null ? DASH : `${num(v).toLocaleString()} / ${num(s.total).toLocaleString()}`}</span> },
    { key: 'free', label: 'Free', align: 'right', render: (v) => <span className="tabular-nums">{v === null ? DASH : v.toLocaleString()}</span> },
  ]

  return (
    <Card span={2} panelId={panelId} title="Top Capacity Risks" note="least free space, excl. infra links" right={<span className="text-note text-muted">top 10</span>} className={OPEN}>
      {!loading && stale && !feedDead && <StaleNote />}
      {loading ? (
        <Skeleton h={220} />
      ) : feedDead ? (
        <FeedUnavailable label="Subnets feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          limit={10}
          onRowClick={(s) => { location.hash = 'network?subnet=' + encodeURIComponent(s.network || '') }}
        />
      )}
    </Card>
  )
}

// ---------- hosts needing attention ----------

function HostsAttention({ hosts, loading, hostsStatus, stale, panelId }) {
  const { COLORS } = useChartTheme()
  const rows = hosts.filter((h) => !/online|active/i.test(h.status || ''))
  const feedDead = hostsStatus === 'error' && hosts.length === 0

  const columns = [
    {
      key: 'name',
      label: 'Hostname',
      keep: true,
      render: (v, h) => (
        <span className="flex items-center gap-2 min-w-0">
          <i className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: COLORS.crit }} />
          <span className="font-mono truncate" style={{ maxWidth: 180 }} title={h.name || h.ip || ''}>
            {h.name || h.ip || '—'}
          </span>
        </span>
      ),
    },
    { key: 'status', label: 'Status', align: 'right' },
  ]

  return (
    <Card
      span={2}
      panelId={panelId}
      title="Hosts Needing Attention"
      className={OPEN}
      // "0 shown" off a dead feed reads as "nothing needs attention".
      right={<span className="text-note text-muted">{loading || feedDead ? '—' : rows.length} shown</span>}
    >
      {!loading && stale && !feedDead && <StaleNote />}
      {loading ? (
        <Skeleton h={220} />
      ) : feedDead ? (
        <FeedUnavailable label="Hosts feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>all hosts online</Empty>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          limit={10}
          viewAllHref="#infra?status=not-online"
          onRowClick={() => { location.hash = 'infra?status=not-online' }}
        />
      )}
    </Card>
  )
}

// ---------- DNS zone issues ----------

function DnsZoneIssues({ zones, loading, zonesStatus, stale, panelId }) {
  const rows = zones
    .filter((z) => Array.isArray(z.issues) && z.issues.length > 0)
    // rowLabel names the row's button for the zone. Without it the name comes
    // from the first cell, which here is only the count of issues.
    .map((z) => ({ ...z, count: z.issues.length, issuesText: z.issues.join(', '), rowLabel: z.fqdn }))
  const feedDead = zonesStatus === 'error' && zones.length === 0

  const columns = [
    {
      key: 'count',
      label: '',
      keep: true,
      width: '2.5rem',
      render: (v) => (
        <span className="inline-block rounded-full px-2 py-0.5 text-note font-medium" style={{ background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)' }}>
          {v}
        </span>
      ),
    },
    { key: 'fqdn', label: 'Zone', mono: true, grow: true },
    { key: 'issuesText', label: 'Issues' },
  ]

  return (
    <Card
      span={2}
      panelId={panelId}
      title="DNS Zone Issues"
      className={OPEN}
      // "0 zones" off a dead feed reads as a clean estate.
      right={<span className="text-note text-muted">{loading || feedDead ? '—' : rows.length} zones</span>}
    >
      {!loading && stale && !feedDead && <StaleNote />}
      {loading ? (
        <Skeleton h={160} />
      ) : feedDead ? (
        <FeedUnavailable label="DNS zones feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no DNS zone issues</Empty>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          limit={10}
          viewAllHref="#dns?issues=1"
          onRowClick={() => { location.hash = 'dns?issues=1' }}
        />
      )}
    </Card>
  )
}
