import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, Skeleton, utilStatus } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useApi } from '../lib/api.js'
import { sliceState } from '../lib/data.js'
import { sampleCountLabel, sampleScopeNote } from '../lib/sampleCount.js'

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

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Daily Briefing</h1>
      {/* The panelIds sit on the call sites, not only on the Card each wrapper
          returns: CardGrid reads panelId off its OWN direct children to apply a
          saved order, and a wrapper that keeps the id inside is invisible to
          that read. Each wrapper forwards it to its Card unchanged. */}
      <CardGrid layoutKey="daily">
        <IssueKpis panelId="daily-open-issues" subnets={subnets} hosts={hosts} zones={zones} totals={totals} meta={meta} loading={data.loading} />
        <SecurityToday panelId="daily-security-today" sec={sec} />
        <TopCapacityRisks panelId="daily-top-capacity-risks" subnets={subnets} loading={data.loading} subnetsStatus={meta.subnets} />
        <HostsAttention panelId="daily-hosts-attention" hosts={hosts} loading={data.loading} hostsStatus={meta.hosts} />
        <DnsZoneIssues panelId="daily-dns-zone-issues" zones={zones} loading={data.loading} zonesStatus={meta.zones} />
      </CardGrid>
    </div>
  )
}

// ---------- KPI cards ----------

function IssueKpis({ subnets, hosts, zones, meta = {}, loading, panelId }) {
  const { COLORS } = useChartTheme()
  // `subnets` (data.subnets) is the union of the first-5,000 page and every
  // subnet with util >= 70, deduped. That union is COMPLETE for any threshold
  // >= 70 — a subnet at util >= 85 is necessarily >= 70, so it cannot be missing
  // from the union. Counting rows here is therefore an exact estate figure for
  // this tile, not a coverage-set sample — do not swap this for a `_totals`
  // lookup (`_totals.subnetsCrit` is util >= 90, a different threshold).
  //
  // The threshold is INCLUSIVE (>= 85) to agree with the drill-down this row
  // links to: Network.jsx keeps `u >= minUtil`, so a strict `> 85` here would
  // show a subnet at exactly 85.0% in the list but not in the count. The
  // `<= 28` rule mirrors that same drill-down (Network.jsx `base`), which drops
  // /29-/32 infra links; it is disclosed in the help copy for this panel.
  const atLeast85 = subnets.filter((s) => (Number(s.cidr) || 0) <= 28 && (Number(s.util) || 0) >= 85).length
  const notOnline = hosts.filter((h) => !/online|active/i.test(h.status || '')).length
  const zoneIssues = zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0).length

  // Each KPI reads a DIFFERENT feed (subnets/hosts/zones) — one can be dead
  // while the other two are fine, so the gate is per-row, not per-card.
  const cells = [
    { label: 'Subnets ≥85% Util', value: atLeast85, color: COLORS.crit, hash: 'network?minUtil=85', status: meta.subnets },
    { label: 'Hosts Not Online', value: notOnline, color: COLORS.warn, hash: 'infra?status=error', status: meta.hosts },
    { label: 'DNS Zones w/ Issues', value: zoneIssues, color: COLORS.other, hash: 'dns?issues=1', status: meta.zones },
  ]

  return (
    <Card span={2} panelId={panelId} title="Open Issues" className="flex flex-col justify-between">
      {loading ? (
        <Skeleton h={160} />
      ) : (
        cells.map((c, i) => {
          const unavailable = c.status === 'error'
          return (
            <div
              key={c.label}
              role="button"
              tabIndex={0}
              onClick={() => { location.hash = c.hash }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = c.hash } }}
              className={`flex items-center justify-between py-3.5 cursor-pointer hover:bg-line ${i < cells.length - 1 ? 'border-b border-line-2' : ''}`}
            >
              <div className="text-muted text-xs">{c.label}</div>
              {unavailable ? (
                <div className="text-xs font-semibold text-right" style={{ color: COLORS.crit }}>unavailable</div>
              ) : (
                <div className="text-2xl font-semibold tracking-tight" style={{ color: c.value > 0 ? c.color : undefined }}>
                  {c.value.toLocaleString()}
                </div>
              )}
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
    { label: 'blocked', value: Number(sec.data?.blocked) || 0, color: COLORS.ok },
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
      span={4}
      panelId={panelId}
      title="Security Today"
      right={<span className="text-[11px] text-muted">{secDead ? '— events' : sampleCountLabel(sec.data, 'events')}</span>}
    >
      {sec.loading ? (
        <Skeleton h={160} />
      ) : secDead ? (
        <FeedUnavailable reason={sec.data?.reason} label="Threat feed unavailable" />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mt-1">
            {chips.map((c) => (
              <div key={c.label} className="text-center py-4 rounded-control bg-line/40">
                <div className="text-2xl font-semibold tracking-tight" style={{ color: c.value > 0 ? c.color : undefined }}>
                  {c.value.toLocaleString()}
                </div>
                <div className="text-[11px] text-muted mt-1 capitalize">{c.label}</div>
              </div>
            ))}
          </div>
          {scopeNote && <div className="text-[11px] text-dim mt-2">{scopeNote}</div>}
        </>
      )}
    </Card>
  )
}

// ---------- top capacity risks ----------

function TopCapacityRisks({ subnets, loading, subnetsStatus, panelId }) {
  const feedDead = subnetsStatus === 'error' && subnets.length === 0
  const rows = [...subnets]
    .filter((s) => (s.addr || s.cidr) && (Number(s.cidr) || 0) <= 28)
    .map((s) => ({
      ...s,
      network: s.addr || s.cidr,
      util: Number(s.util) || 0,
      free: (Number(s.total) || 0) - (Number(s.used) || 0),
    }))
    .sort((a, b) => a.free - b.free)

  const columns = [
    { key: 'network', label: 'Network', mono: true },
    { key: 'site', label: 'Site', keep: true },
    {
      key: 'util',
      label: 'Util',
      keep: true,
      render: (v) => {
        const st = utilStatus(v)
        return (
          <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: st.bg, color: st.fg }}>
            {v}%
          </span>
        )
      },
    },
    { key: 'free', label: 'Free', align: 'right', render: (v) => <span className="text-muted">{(v || 0).toLocaleString()}</span> },
  ]

  return (
    <Card span={3} panelId={panelId} title="Top Capacity Risks" note="least free space, excl. infra links" right={<span className="text-[11px] text-muted">top 10</span>}>
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

function HostsAttention({ hosts, loading, hostsStatus, panelId }) {
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
      span={3}
      panelId={panelId}
      title="Hosts Needing Attention"
      // "0 shown" off a dead feed reads as "nothing needs attention".
      right={<span className="text-[11px] text-muted">{feedDead ? '—' : rows.length} shown</span>}
    >
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
          viewAllHref="#infra?status=error"
          onRowClick={() => { location.hash = 'infra?status=error' }}
        />
      )}
    </Card>
  )
}

// ---------- DNS zone issues ----------

function DnsZoneIssues({ zones, loading, zonesStatus, panelId }) {
  const rows = zones
    .filter((z) => Array.isArray(z.issues) && z.issues.length > 0)
    .map((z) => ({ ...z, count: z.issues.length, issuesText: z.issues.join(', ') }))
  const feedDead = zonesStatus === 'error' && zones.length === 0

  const columns = [
    {
      key: 'count',
      label: '',
      keep: true,
      width: '2.5rem',
      render: (v) => (
        <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)' }}>
          {v}
        </span>
      ),
    },
    { key: 'fqdn', label: 'Zone', mono: true, grow: true },
    { key: 'issuesText', label: 'Issues' },
  ]

  return (
    <Card
      span={6}
      panelId={panelId}
      title="DNS Zone Issues"
      // "0 zones" off a dead feed reads as a clean estate.
      right={<span className="text-[11px] text-muted">{feedDead ? '—' : rows.length} zones</span>}
    >
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
