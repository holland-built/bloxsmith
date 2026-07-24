import { useChartTheme, Card, CardGrid, Empty, Skeleton, utilStatus } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useApi } from '../lib/api.js'

// ---------- main ----------

export default function Daily() {
  const data = useApi('/api/data', { poll: 30000 })
  const sec = useApi('/api/hub/security', { poll: 30000 })

  const subnets = data.data?.subnets ?? []
  const hosts = data.data?.hosts ?? []
  const zones = data.data?.zones ?? []

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Daily Briefing</h1>
      <CardGrid>
        <IssueKpis subnets={subnets} hosts={hosts} zones={zones} loading={data.loading} />
        <SecurityToday sec={sec} />
        <TopCapacityRisks subnets={subnets} loading={data.loading} />
        <HostsAttention hosts={hosts} loading={data.loading} />
        <DnsZoneIssues zones={zones} loading={data.loading} />
      </CardGrid>
    </div>
  )
}

// ---------- KPI cards ----------

function IssueKpis({ subnets, hosts, zones, loading }) {
  const { COLORS } = useChartTheme()
  const gt85 = subnets.filter((s) => (Number(s.cidr) || 0) <= 28 && (Number(s.util) || 0) > 85).length
  const notOnline = hosts.filter((h) => !/online|active/i.test(h.status || '')).length
  const zoneIssues = zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0).length

  const cells = [
    { label: 'Subnets >85% Util', value: gt85, color: COLORS.crit, hash: 'network?minUtil=85' },
    { label: 'Hosts Not Online', value: notOnline, color: COLORS.warn, hash: 'infra?status=error' },
    { label: 'DNS Zones w/ Issues', value: zoneIssues, color: COLORS.other, hash: 'dns?issues=1' },
  ]

  return (
    <Card span={2} title="Open Issues" className="flex flex-col justify-between">
      {loading ? (
        <Skeleton h={160} />
      ) : (
        cells.map((c, i) => (
          <div
            key={c.label}
            onClick={() => { location.hash = c.hash }}
            className={`flex items-center justify-between py-3.5 cursor-pointer hover:bg-line ${i < cells.length - 1 ? 'border-b border-line-2' : ''}`}
          >
            <div className="text-muted text-xs">{c.label}</div>
            <div className="text-2xl font-semibold tracking-tight" style={{ color: c.value > 0 ? c.color : undefined }}>
              {c.value.toLocaleString()}
            </div>
          </div>
        ))
      )}
    </Card>
  )
}

// ---------- security today ----------

function SecurityToday({ sec }) {
  const { COLORS } = useChartTheme()
  const counts = sec.data?.counts ?? {}
  const events = sec.data?.events ?? []
  const chips = [
    { label: 'critical', value: Number(counts.critical) || 0, color: COLORS.crit },
    { label: 'high', value: Number(counts.high) || 0, color: COLORS.warn },
    { label: 'medium', value: Number(counts.medium) || 0, color: COLORS.other },
    { label: 'blocked', value: Number(sec.data?.blocked) || 0, color: COLORS.ok },
  ]

  return (
    <Card span={4} title="Security Today" right={<span className="text-[11px] text-muted">{events.length.toLocaleString()} events</span>}>
      {sec.loading ? (
        <Skeleton h={160} />
      ) : sec.error || (!sec.data) ? (
        <Empty />
      ) : (
        <div className="grid grid-cols-4 gap-3 mt-1">
          {chips.map((c) => (
            <div key={c.label} className="text-center py-4 rounded-lg bg-line/40">
              <div className="text-2xl font-semibold tracking-tight" style={{ color: c.value > 0 ? c.color : undefined }}>
                {c.value.toLocaleString()}
              </div>
              <div className="text-[11px] text-muted mt-1 capitalize">{c.label}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------- top capacity risks ----------

function TopCapacityRisks({ subnets, loading }) {
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
    { key: 'network', label: 'Network', mono: true, clip: 160 },
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
    <Card span={3} title="Top Capacity Risks" note="least free space, excl. infra links" right={<span className="text-[11px] text-muted">top 10</span>}>
      {loading ? (
        <Skeleton h={220} />
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

function HostsAttention({ hosts, loading }) {
  const { COLORS } = useChartTheme()
  const rows = hosts.filter((h) => !/online|active/i.test(h.status || ''))

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
    <Card span={3} title="Hosts Needing Attention" right={<span className="text-[11px] text-muted">{rows.length} shown</span>}>
      {loading ? (
        <Skeleton h={220} />
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

function DnsZoneIssues({ zones, loading }) {
  const rows = zones
    .filter((z) => Array.isArray(z.issues) && z.issues.length > 0)
    .map((z) => ({ ...z, count: z.issues.length, issuesText: z.issues.join(', ') }))

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
    { key: 'fqdn', label: 'Zone', mono: true, clip: 240 },
    { key: 'issuesText', label: 'Issues' },
  ]

  return (
    <Card span={6} title="DNS Zone Issues" right={<span className="text-[11px] text-muted">{rows.length} zones</span>}>
      {loading ? (
        <Skeleton h={160} />
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
