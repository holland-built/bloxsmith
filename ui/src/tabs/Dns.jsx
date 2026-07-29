import { useMemo, useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, Skeleton, utilStatus } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useHashParams } from '../lib/hash.js'
import { useThemeColors } from '../lib/theme.jsx'

// ---------- main ----------

export default function Dns() {
  const qps = useApi('/api/csp/dns-qps', { poll: 30000 })
  const services = useApi('/api/csp/dns-services', { poll: 30000 })
  // Re-enabled 2026-07-22: MCP calls now carry a bounded 12s deadline (mcp.go post()),
  // so a stalled feed errors out instead of hanging goroutines / starving the upstream.
  const analytics = useApi('/api/dns-analytics', { poll: 30000 })
  const data = useApi('/api/data', { poll: 30000 })
  const dnssec = useApi('/api/csp/dnssec', { poll: 30000 })
  const rpz = useApi('/api/csp/rpz', { poll: 30000 })
  const dtcLbdn = useApi('/api/csp/dtc-lbdn', { poll: 30000 })

  const hp = useHashParams()
  const zones = data.data?.zones ?? []
  const zonesStatus = data.data?._meta?.zones

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">DNS</h1>
      <CardGrid>
        <QpsHero qps={qps} />
        <ZoneKpis zones={zones} zonesStatus={zonesStatus} />
        <DnsServices services={services} />
        <QueryVolume7d analytics={analytics} />
        <ZoneTable zones={zones} issuesOnly={!!hp.issues} zonesStatus={zonesStatus} />
        <DnssecHealth dnssec={dnssec} />
        <RpzPanel rpz={rpz} />
        <DtcLbdnPanel dtcLbdn={dtcLbdn} />
      </CardGrid>
    </div>
  )
}

// ---------- hero ----------

function QpsHero({ qps }) {
  const { COLORS, TT } = useChartTheme()
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
      span={4}
      title="DNS Query Rate — 24h"
      right={<span className="flex items-center gap-1.5 text-[11px] text-muted"><i className="w-2 h-2 rounded-sm inline-block" style={{ background: COLORS.accent }} />avg qps</span>}
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
            <span className="text-[30px] font-semibold tracking-tight">{current?.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
            {delta != null && (
              <span className="text-xs" style={{ color: flat ? COLORS.other : delta >= 0 ? COLORS.ok : COLORS.crit }}>
                {flat ? '— flat' : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}%`} vs first hour
              </span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="qpsFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={COLORS.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--color-grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: 'var(--color-tick)', fontSize: 11 }} axisLine={{ stroke: 'var(--color-grid)' }} tickLine={false} minTickGap={40} />
              <YAxis hide domain={['dataMin - 0.5', 'dataMax + 0.5']} />
              <Tooltip {...TT} />
              <Area type="monotone" dataKey="value" stroke={COLORS.accent} strokeWidth={1.8} fill="url(#qpsFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </>
      )}
    </Card>
  )
}

// ---------- zone kpis ----------

function ZoneKpis({ zones, zonesStatus }) {
  const { COLORS } = useChartTheme()
  // All three cells read the same `zones` feed — a dead read means none of
  // these counts are known, not that they're all zero.
  if (zones.length === 0 && zonesStatus === 'error') {
    return (
      <Card span={2} className="flex flex-col justify-between">
        <FeedUnavailable label="DNS zones feed unavailable" />
      </Card>
    )
  }

  const issueCount = zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0).length
  const anomalyCount = zones.filter((z) => z.anomaly).length

  const cells = [
    { label: 'Zones', value: zones.length.toLocaleString() },
    { label: 'Zones w/ issues', value: issueCount.toLocaleString(), color: issueCount > 0 ? COLORS.crit : COLORS.accent },
    { label: 'Anomalies', value: anomalyCount.toLocaleString(), color: anomalyCount > 0 ? COLORS.warn : COLORS.accent },
  ]

  return (
    <Card span={2} className="flex flex-col justify-between">
      {cells.map((c, i) => (
        <div key={c.label} className={`py-3.5 ${i < cells.length - 1 ? 'border-b border-line-2' : ''}`}>
          <div className="text-muted text-xs">{c.label}</div>
          <div className="text-2xl font-semibold tracking-tight my-1" style={{ color: c.color }}>{c.value}</div>
        </div>
      ))}
    </Card>
  )
}

// ---------- dns services ----------

function DnsServices({ services }) {
  const rows = services.data?.rows ?? []
  const status = services.data?.status

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'comment', label: 'Comment', grow: true },
    { key: 'pool_id', label: 'Pool ID', mono: true },
  ]

  return (
    <Card span={3} title="DNS Services" right={<span className="text-[11px] text-muted">{rows.length ? `${rows.length} services` : ''}</span>}>
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

function QueryVolume7d({ analytics }) {
  const { COLORS, TT } = useChartTheme()
  // dns-analytics can legitimately return zero rows for a tenant with no query
  // activity — that must render as empty, not as a dead feed. Only a fetch
  // error or an explicit availability:"error" from the backend (a dead
  // cubejs) counts as broken; a genuinely empty "ok" fetch does not.
  const volume = analytics.data?.volume ?? []
  const broken = !!analytics.error || analytics.data?.availability === 'error'
  const chartData = volume.map((r, i) => ({ label: r.hour ?? i, value: Number(r.total_query_count) || 0 }))

  return (
    <Card span={3} title="Query Volume — 7d" note={broken ? 'feed unavailable' : undefined}>
      {analytics.loading ? (
        <Skeleton h={180} />
      ) : broken ? (
        <Empty>no data</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="volFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.purple} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLORS.purple} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--color-grid)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: 'var(--color-tick)', fontSize: 11 }} axisLine={{ stroke: 'var(--color-grid)' }} tickLine={false} minTickGap={40} />
            <YAxis hide />
            <Tooltip {...TT} />
            <Area type="monotone" dataKey="value" stroke={COLORS.purple} strokeWidth={1.8} fill="url(#volFill)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  )
}

// ---------- zone table ----------

function ZoneTable({ zones, issuesOnly, zonesStatus }) {
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
      let av, bv
      if (key === 'fqdn') { av = a.fqdn || ''; bv = b.fqdn || '' }
      else if (key === 'view') { av = a.view || ''; bv = b.view || '' }
      else if (key === 'records') { av = Number(a.records) || 0; bv = Number(b.records) || 0 }
      else if (key === 'ttl') { av = Number(a.ttl) || 0; bv = Number(b.ttl) || 0 }
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
      <span className="font-mono text-[11px]" style={{ color: COLORS.crit }}>{z.issues.join(', ')}</span>
    ) : z.anomaly ? (
      <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: 'var(--pill-warn-bg)', color: 'var(--pill-warn-fg)' }}>anomaly</span>
    ) : '—'
    return {
      fqdn: z.fqdn,
      view: z.view,
      records: (Number(z.records) || 0).toLocaleString(),
      ttl: z.ttl,
      issues: issuesCell,
      _hasIssues: hasIssues,
    }
  }), [sorted, COLORS])

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, keep: true, grow: true, sortable: true },
    { key: 'view', label: 'View', sortable: true },
    { key: 'records', label: 'Records', align: 'right', hideWhenConstant: true, sortable: true },
    { key: 'ttl', label: 'TTL', mono: true, sortable: true },
    { key: 'issues', label: 'Issues', hideWhenConstant: true, sortable: true },
  ]

  return (
    <Card
      span={6}
      title={
        issuesOnly ? (
          <span className="inline-flex items-center gap-2">
            DNS Zones
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => { location.hash = 'dns' }}
              className="text-[11px] font-medium px-2 py-0.5 rounded-full cursor-pointer"
              style={{ background: theme.pillNeutralBg, color: theme.pillNeutralFg }}
            >
              issues only ✕
            </button>
          </span>
        ) : 'DNS Zones'
      }
      right={
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] text-muted whitespace-nowrap">{sorted.length.toLocaleString()} zones</span>
          <input
            aria-label="Filter zones"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-[170px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
        </div>
      }
    >
      {zones.length === 0 ? (
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

function DnssecHealth({ dnssec }) {
  const { COLORS } = useChartTheme()
  const rows = dnssec.data?.rows ?? []
  const total = dnssec.data?.count ?? rows.length
  // CSPDnssec returns status:"error" at HTTP 200 on an upstream failure — the
  // fetch itself never errors, so `dnssec.error` alone never catches this.
  const status = dnssec.data?.status

  const signedCount = rows.filter((r) => r.dnssec_status === 'SIGNED').length
  const unsignedCount = rows.filter((r) => r.dnssec_status === 'UNSIGNED').length
  const signedShare = rows.length ? (signedCount / rows.length) * 100 : null

  const unsigned = rows.filter((r) => r.dnssec_status === 'UNSIGNED')
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
      span={3}
      title="DNSSEC Health"
      right={
        <span className="text-[11px] text-muted">
          {unsigned.length > DNSSEC_CAP
            ? `worst ${DNSSEC_CAP} of ${unsigned.length.toLocaleString()} unsigned`
            : unsigned.length
              ? `${unsigned.length.toLocaleString()} unsigned`
              : ''}
        </span>
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
              <div className="text-2xl font-semibold tracking-tight" style={{ color: COLORS.ok }}>{signedCount.toLocaleString()}</div>
              <div className="text-[11px] text-muted">signed</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tracking-tight" style={{ color: unsignedCount > 0 ? COLORS.crit : COLORS.ok }}>{unsignedCount.toLocaleString()}</div>
              <div className="text-[11px] text-muted">unsigned</div>
            </div>
            {signedShare != null && (
              <div>
                <div className="text-2xl font-semibold tracking-tight">{signedShare.toFixed(1)}%</div>
                <div className="text-[11px] text-muted">signed share (of {total.toLocaleString()})</div>
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

function RpzPanel({ rpz }) {
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
    <Card span={3} title="RPZ Policy Zones" right={<span className="text-[11px] text-muted">{rows.length ? `${total.toLocaleString()} zones` : ''}</span>}>
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

function DtcLbdnPanel({ dtcLbdn }) {
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
    <Card span={3} title="DTC Load-Balanced Names" right={<span className="text-[11px] text-muted">{rows.length ? `${total.toLocaleString()} names` : ''}</span>}>
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
