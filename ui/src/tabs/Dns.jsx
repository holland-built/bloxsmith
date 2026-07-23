import { useMemo, useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, Empty, Skeleton, utilStatus } from '../components/ui.jsx'
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

  const hp = useHashParams()
  const zones = data.data?.zones ?? []

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">DNS</h1>
      <div className="grid grid-cols-6 gap-3">
        <QpsHero qps={qps} />
        <ZoneKpis zones={zones} />
        <DnsServices services={services} />
        <QueryVolume7d analytics={analytics} />
        <ZoneTable zones={zones} issuesOnly={!!hp.issues} />
      </div>
    </div>
  )
}

// ---------- hero ----------

function QpsHero({ qps }) {
  const { COLORS, TT } = useChartTheme()
  const rows = qps.data?.rows ?? []
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
      ) : qps.error || chartData.length === 0 ? (
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

function ZoneKpis({ zones }) {
  const { COLORS } = useChartTheme()
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

  return (
    <Card span={3} title="DNS Services" right={<span className="text-[11px] text-muted">{rows.length ? `${rows.length} services` : ''}</span>}>
      {services.loading ? (
        <Skeleton h={180} />
      ) : services.error || status === 'error' || rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="max-h-[220px] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Name</th>
                <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Comment</th>
                <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Pool ID</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id ?? i}>
                  <td className="py-2 px-2.5 border-b border-line">{r.name || '—'}</td>
                  <td className="py-2 px-2.5 border-b border-line text-muted">{r.comment || '—'}</td>
                  <td className="py-2 px-2.5 border-b border-line font-mono text-muted">{r.pool_id || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ---------- query volume 7d (known-broken feed) ----------

function QueryVolume7d({ analytics }) {
  const { COLORS, TT } = useChartTheme()
  // dns-analytics is a known-broken feed — an empty/errored response must render
  // Empty/"—", never a fabricated 0 or invented volume.
  const volume = analytics.data?.volume ?? []
  const broken = !!analytics.error || volume.length === 0
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

function ZoneTable({ zones, issuesOnly }) {
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

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const headers = [
    { key: 'fqdn', label: 'Zone' },
    { key: 'view', label: 'View' },
    { key: 'records', label: 'Records' },
    { key: 'ttl', label: 'TTL' },
    { key: 'issues', label: 'Issues' },
  ]

  return (
    <Card
      span={6}
      title={
        issuesOnly ? (
          <span className="inline-flex items-center gap-2">
            DNS Zones
            <span
              onClick={() => { location.hash = 'dns' }}
              className="text-[11px] font-medium px-2 py-0.5 rounded-full cursor-pointer"
              style={{ background: theme.pillNeutralBg, color: theme.pillNeutralFg }}
            >
              issues only ✕
            </span>
          </span>
        ) : 'DNS Zones'
      }
      right={
        <input
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-[170px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
        />
      }
    >
      {zones.length === 0 ? (
        <Empty />
      ) : sorted.length === 0 ? (
        <Empty>no zones match</Empty>
      ) : (
        <table className="w-full border-collapse mt-2.5 text-sm">
          <thead>
            <tr>
              {headers.map((h) => (
                <th
                  key={h.key}
                  onClick={() => toggleSort(h.key)}
                  className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2 cursor-pointer select-none"
                >
                  {h.label}{sort.key === h.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((z, i) => {
              const hasIssues = Array.isArray(z.issues) && z.issues.length > 0
              return (
                <tr key={(z.fqdn || '') + i} style={hasIssues ? { background: 'rgba(238,68,68,0.06)' } : undefined}>
                  <td className="py-2.5 px-2.5 border-b border-line font-mono">{z.fqdn || '—'}</td>
                  <td className="py-2.5 px-2.5 border-b border-line">{z.view || '—'}</td>
                  <td className="py-2.5 px-2.5 border-b border-line text-muted">{(Number(z.records) || 0).toLocaleString()}</td>
                  <td className="py-2.5 px-2.5 border-b border-line text-muted font-mono">{z.ttl ?? '—'}</td>
                  <td className="py-2.5 px-2.5 border-b border-line">
                    {hasIssues ? (
                      <span className="font-mono text-[11px]" style={{ color: COLORS.crit }}>{z.issues.join(', ')}</span>
                    ) : z.anomaly ? (
                      <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: 'var(--pill-warn-bg)', color: 'var(--pill-warn-fg)' }}>anomaly</span>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}
