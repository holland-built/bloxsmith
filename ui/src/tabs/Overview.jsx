import { useMemo, useState } from 'react'
import {
  AreaChart, Area, BarChart, Bar, Cell, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, Empty, Skeleton, Sparkline, utilStatus } from '../components/ui.jsx'
import { useThemeColors } from '../lib/theme.jsx'

// ---------- main ----------

export default function Overview() {
  const dns = useApi('/api/csp/dns-qps', { poll: 30000 })
  const data = useApi('/api/data', { poll: 30000 })

  const subnets = data.data?.subnets ?? []
  const leases = data.data?.leases ?? []
  const hosts = data.data?.hosts ?? []

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Overview</h1>
      <div className="grid grid-cols-6 gap-3">
        <DnsHero dns={dns} />
        <KpiStack subnets={subnets} leases={leases} />
        <TopUtilization subnets={subnets} />
        <SubnetHeatmap subnets={subnets} />
        <HostStatus hosts={hosts} />
        <SubnetTable subnets={subnets} />
      </div>
    </div>
  )
}

// ---------- hero ----------

function DnsHero({ dns }) {
  const { COLORS, TT } = useChartTheme()
  const theme = useThemeColors()
  const rows = dns.data?.rows ?? []
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
      title={<span onClick={() => { location.hash = 'dns' }} className="cursor-pointer hover:opacity-80 transition-opacity">DNS Query Rate — 24h</span>}
      right={<span className="flex items-center gap-1.5 text-[11px] text-muted"><i className="w-2 h-2 rounded-sm inline-block" style={{ background: COLORS.accent }} />avg qps</span>}
    >
      {dns.loading ? (
        <Skeleton h={250} />
      ) : dns.error || chartData.length === 0 ? (
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
                <linearGradient id="dnsFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={COLORS.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: theme.tick, fontSize: 11 }} axisLine={{ stroke: theme.grid }} tickLine={false} minTickGap={40} />
              <YAxis hide domain={['dataMin - 0.5', 'dataMax + 0.5']} />
              <Tooltip {...TT} />
              <Area type="monotone" dataKey="value" stroke={COLORS.accent} strokeWidth={1.8} fill="url(#dnsFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </>
      )}
    </Card>
  )
}

// ---------- kpi stack ----------

function KpiStack({ subnets, leases }) {
  const { COLORS } = useChartTheme()
  const utils = [...subnets.map((s) => Number(s.util) || 0)].sort((a, b) => a - b)
  const activeLeases = leases.filter((l) => l.state === 'active').length
  const critSubnets = subnets.filter((s) => Number(s.util) >= 90).length

  const cells = [
    { label: 'Active Leases', value: activeLeases.toLocaleString(), color: COLORS.accent, hash: 'network?focus=leases' },
    { label: 'Subnets', value: subnets.length.toLocaleString(), color: COLORS.purple, hash: 'network' },
    { label: 'Subnets ≥90%', value: critSubnets.toLocaleString(), color: COLORS.crit, hash: 'network?minUtil=90' },
  ]

  return (
    <Card span={2} className="flex flex-col justify-between">
      {cells.map((c, i) => (
        <div
          key={c.label}
          onClick={() => { location.hash = c.hash }}
          className={`py-3.5 cursor-pointer hover:bg-line rounded-lg transition-colors px-1 -mx-1 ${i < cells.length - 1 ? 'border-b border-line-2' : ''}`}
        >
          <div className="text-muted text-xs">{c.label}</div>
          <div className="text-2xl font-semibold tracking-tight my-1">{c.value}</div>
          {utils.length > 1 ? (
            <>
              <Sparkline values={utils} color={c.color} />
              <div className="text-[10px] text-dim mt-0.5">util distribution (sorted), not history</div>
            </>
          ) : (
            <div className="h-[30px]" />
          )}
        </div>
      ))}
    </Card>
  )
}

// ---------- top utilization ----------

function TopUtilization({ subnets }) {
  const { COLORS, TT } = useChartTheme()
  const theme = useThemeColors()
  // Rank by addresses USED, not util% — util ranking is a wall of 100% /32 infra links
  // (learned in old app: commits 7789ae8 / 46e591c)
  const top = [...subnets]
    .filter((s) => s.addr || s.cidr)
    .sort((a, b) => (Number(b.used) || 0) - (Number(a.used) || 0))
    .slice(0, 12)

  return (
    <Card span={2} title="Top Consumers" right={<span className="text-[11px] text-muted">addresses used · top 12</span>}>
      {top.length === 0 ? (
        <Empty />
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={top} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <XAxis dataKey="addr" tick={false} axisLine={{ stroke: theme.grid }} tickLine={false} />
            <YAxis hide />
            <Tooltip
              contentStyle={TT.contentStyle}
              labelStyle={{ color: theme.txt }}
              formatter={(v, _n, p) => [`${Number(v).toLocaleString()} used (${p?.payload?.util ?? '?'}%)`, null]}
              labelFormatter={(_, p) => p?.[0]?.payload?.addr ?? p?.[0]?.payload?.cidr ?? ''}
            />
            <Bar
              dataKey="used"
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
              cursor="pointer"
              onClick={(payload) => {
                const addr = payload?.addr
                if (addr) location.hash = 'network?subnet=' + encodeURIComponent(addr)
              }}
            >
              {top.map((s, i) => (
                <Cell key={i} fill={COLORS.purple} fillOpacity={1 - (i / top.length) * 0.6} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  )
}

// ---------- subnet heatmap ----------

function SubnetHeatmap({ subnets }) {
  const { COLORS } = useChartTheme()
  // Worst N only — a cell per subnet at 5k subnets = sub-pixel rects (invisible). Cap + say so.
  const CAP = 288 // 24 x 12
  // /29-/32 are infra links, always ~100% — they'd paint the whole map red (old app: 67db14e)
  const all = subnets.filter((s) => (s.addr || s.cidr) && (Number(s.cidr) || 0) <= 28)
  const cells = [...all].sort((a, b) => (Number(b.util) || 0) - (Number(a.util) || 0)).slice(0, CAP)
  const cols = 24
  const rows = Math.max(1, Math.ceil(cells.length / cols))
  const gap = 0.6
  const cw = 100 / cols
  const ch = 100 / rows

  return (
    <Card span={2} title="Subnet Heatmap" right={<span className="text-[11px] text-muted">{all.length > CAP ? `worst ${CAP} of ${all.length.toLocaleString()}` : 'util by subnet'}</span>}>
      {cells.length === 0 ? (
        <Empty />
      ) : (
        <>
          <svg width="100%" height="110" viewBox="0 0 100 100" preserveAspectRatio="none">
            {cells.map((s, i) => {
              const util = Number(s.util) || 0
              const r = Math.floor(i / cols)
              const c = i % cols
              const color = util >= 92 ? COLORS.crit : util >= 75 ? COLORS.warn : COLORS.accent
              const opacity = Math.max(0.15, Math.min(1, util / 100))
              return (
                <rect
                  key={s.addr || s.cidr || i}
                  x={c * cw + gap / 2}
                  y={r * ch + gap / 2}
                  width={cw - gap}
                  height={ch - gap}
                  rx={0.8}
                  fill={color}
                  opacity={opacity}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const addr = s.addr || s.cidr
                    if (addr) location.hash = 'network?subnet=' + encodeURIComponent(addr)
                  }}
                >
                  <title>{`${s.addr || s.cidr} — ${util}%`}</title>
                </rect>
              )
            })}
          </svg>
          <div className="flex gap-3.5 mt-2 text-[11px] text-muted">
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm inline-block" style={{ background: COLORS.accent }} />ok</span>
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm inline-block" style={{ background: COLORS.warn }} />&gt;75%</span>
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm inline-block" style={{ background: COLORS.crit }} />&gt;92%</span>
          </div>
        </>
      )}
    </Card>
  )
}

// ---------- host status ----------

function HostStatus({ hosts }) {
  const { COLORS, TT } = useChartTheme()
  const buckets = { Active: 0, Degraded: 0, Offline: 0, Other: 0 }
  for (const h of hosts) {
    const s = h.status || ''
    if (/online|up|active/i.test(s)) buckets.Active++
    else if (/degraded|warn/i.test(s)) buckets.Degraded++
    else if (/off|down|error|fail/i.test(s)) buckets.Offline++
    else buckets.Other++
  }
  const colorMap = { Active: COLORS.accent, Degraded: COLORS.warn, Offline: COLORS.crit, Other: COLORS.other }
  const total = hosts.length
  const pieData = Object.entries(buckets)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value, color: colorMap[name] }))

  return (
    <Card span={2} title="Host Status">
      {total === 0 ? (
        <Empty />
      ) : (
        <div className="flex items-center gap-4">
          <div className="relative w-[130px] h-[130px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  innerRadius={44}
                  outerRadius={62}
                  startAngle={90}
                  endAngle={-270}
                  stroke="none"
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(d) => { location.hash = 'infra?status=' + d.name.toLowerCase() }}
                >
                  {pieData.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={TT.contentStyle} />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-lg font-semibold">{total.toLocaleString()}</span>
              <span className="text-dim text-[11px]">hosts</span>
            </div>
          </div>
          <div className="flex-1 flex flex-col gap-2">
            {pieData.map((d) => (
              <div
                key={d.name}
                onClick={() => { location.hash = 'infra?status=' + d.name.toLowerCase() }}
                className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-line rounded-lg transition-colors px-1 -mx-1"
              >
                <i className="w-2 h-2 rounded-sm inline-block" style={{ background: d.color }} />
                <span className="text-muted flex-1">{d.name}</span>
                <b>{((d.value / total) * 100).toFixed(0)}%</b>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// ---------- table ----------

function SubnetTable({ subnets }) {
  const [filter, setFilter] = useState('')
  const [site, setSite] = useState('')
  const [sort, setSort] = useState({ key: 'util', dir: 'desc' })

  const sites = useMemo(() => [...new Set(subnets.map((s) => s.site).filter(Boolean))].sort(), [subnets])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return subnets.filter((s) => {
      // /29-/32 infra links are always ~100% — they bury real exhaustion (old app: 67db14e)
      if ((Number(s.cidr) || 0) > 28) return false
      if (site && s.site !== site) return false
      if (!q) return true
      return [s.addr, s.cidr, s.site, s.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [subnets, filter, site])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    arr.sort((a, b) => {
      let av, bv
      if (key === 'network') { av = a.addr || a.cidr || ''; bv = b.addr || b.cidr || '' }
      else if (key === 'site') { av = a.site || ''; bv = b.site || '' }
      else if (key === 'free') { av = (Number(a.total) || 0) - (Number(a.used) || 0); bv = (Number(b.total) || 0) - (Number(b.used) || 0) }
      else if (key === 'util') { av = Number(a.util) || 0; bv = Number(b.util) || 0 }
      else { av = Number(a.util) || 0; bv = Number(b.util) || 0 }
      if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return dir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [filtered, sort])

  const top15 = sorted.slice(0, 15)

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))
  }

  function exportCsv() {
    const header = ['Network', 'Site', 'Utilization', 'Status', 'Free']
    const lines = [header.join(',')]
    for (const s of sorted) {
      const util = Number(s.util) || 0
      const free = (Number(s.total) || 0) - (Number(s.used) || 0)
      const status = utilStatus(util).label
      const network = s.addr || s.cidr || ''
      lines.push([network, s.site || '', `${util}%`, status, free].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'top-subnets.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const headers = [
    { key: 'network', label: 'Network' },
    { key: 'site', label: 'Site' },
    { key: 'util', label: 'Utilization' },
    { key: 'status', label: 'Status', noSort: true },
    { key: 'free', label: 'Free' },
  ]

  return (
    <Card
      span={6}
      title="Top Subnets by Utilization"
      note="excl. /29–/32 infra links"
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-[170px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          <select
            value={site}
            onChange={(e) => setSite(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button onClick={exportCsv} className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm">
            Export CSV
          </button>
        </div>
      }
    >
      {subnets.length === 0 ? (
        <Empty />
      ) : top15.length === 0 ? (
        <Empty>no subnets match</Empty>
      ) : (
        <table className="w-full border-collapse mt-2.5 text-sm">
          <thead>
            <tr>
              {headers.map((h) => (
                <th
                  key={h.key}
                  onClick={() => !h.noSort && toggleSort(h.key)}
                  className={`text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2 ${h.noSort ? '' : 'cursor-pointer select-none'}`}
                >
                  {h.label}{sort.key === h.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {top15.map((s, i) => {
              const util = Number(s.util) || 0
              const free = (Number(s.total) || 0) - (Number(s.used) || 0)
              const status = utilStatus(util)
              const network = s.addr || s.cidr || '—'
              return (
                <tr
                  key={network + i}
                  onClick={() => {
                    const addr = s.addr || s.cidr
                    if (addr) location.hash = 'network?subnet=' + encodeURIComponent(addr)
                  }}
                  className="cursor-pointer hover:bg-line/50"
                >
                  <td className="py-2.5 px-2.5 border-b border-line font-mono">{network}</td>
                  <td className="py-2.5 px-2.5 border-b border-line">{s.site || '—'}</td>
                  <td className="py-2.5 px-2.5 border-b border-line" style={{ width: '26%' }}>
                    <div className="flex items-center gap-2">
                      <div className="h-[5px] rounded-full bg-line overflow-hidden flex-1 min-w-[70px]">
                        <div className="h-full" style={{ width: `${Math.min(100, util)}%`, background: status.color }} />
                      </div>
                      <span className="text-muted w-9 text-right">{util}%</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-2.5 border-b border-line">
                    <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: status.bg, color: status.fg }}>
                      {status.label}
                    </span>
                  </td>
                  <td className="py-2.5 px-2.5 border-b border-line text-muted">{free.toLocaleString()} free</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}
