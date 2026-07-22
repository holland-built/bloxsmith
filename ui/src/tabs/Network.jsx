import { useMemo, useState } from 'react'
import {
  BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { COLORS, TT, Card, Empty, Skeleton, utilStatus } from '../components/ui.jsx'

// ---------- main ----------

export default function Network() {
  const data = useApi('/api/data', { poll: 30000 })
  const ipam = useApi('/api/csp/ipam-util', { poll: 30000 })
  const dhcp = useApi('/api/csp/dhcp-leases', { poll: 30000 })

  const subnets = data.data?.subnets ?? []

  return (
    <div className="max-w-[1340px] mx-auto p-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Network</h1>
      <div className="grid grid-cols-6 gap-3">
        <UtilBands subnets={subnets} />
        <IpamSpaces ipam={ipam} />
        <DhcpLeases dhcp={dhcp} />
        <ExhaustionTable subnets={subnets} />
      </div>
    </div>
  )
}

// ---------- utilization distribution ----------

const BANDS = [
  { key: '0-70', label: '<70%', test: (u) => u < 70, color: COLORS.accent },
  { key: '70-85', label: '70–85%', test: (u) => u >= 70 && u <= 85, color: COLORS.warn },
  { key: '85-100', label: '>85%', test: (u) => u > 85, color: COLORS.crit },
]

function UtilBands({ subnets }) {
  const counts = BANDS.map((b) => ({
    label: b.label,
    value: subnets.filter((s) => b.test(Number(s.util) || 0)).length,
    color: b.color,
  }))
  const hasData = subnets.length > 0

  return (
    <Card span={3} title="Utilization Distribution" right={<span className="text-[11px] text-muted">subnets by band</span>}>
      {!hasData ? (
        <Empty />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={counts} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#222" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#777', fontSize: 11 }} axisLine={{ stroke: '#222' }} tickLine={false} />
            <YAxis tick={{ fill: '#777', fontSize: 11 }} axisLine={{ stroke: '#222' }} tickLine={false} allowDecimals={false} />
            <Tooltip {...TT} formatter={(v) => [`${v} subnets`, null]} />
            <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {counts.map((c) => (
                <Cell key={c.label} fill={c.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  )
}

// ---------- IPAM spaces ----------

function IpamSpaces({ ipam }) {
  const rows = (ipam.data?.rows ?? [])
    .filter((r) => (Number(r.total) || 0) > 0)
    .map((r) => ({ ...r, used: Number(r.used) || 0, total: Number(r.total) || 0, pct: ((Number(r.used) || 0) / (Number(r.total) || 1)) * 100 }))
    .sort((a, b) => b.used - a.used)
    .slice(0, 12)

  return (
    <Card span={3} title="IPAM Spaces — Top Used" right={<span className="text-[11px] text-muted">addresses used</span>}>
      {ipam.loading ? (
        <Skeleton h={220} />
      ) : ipam.error || rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="flex flex-col gap-2 mt-1">
          {rows.map((r, i) => {
            const status = utilStatus(r.pct)
            return (
              <div key={r.id || r.label || i} className="flex items-center gap-2 text-xs">
                <span className="w-[110px] truncate text-muted" title={r.label}>{r.label || r.id || '—'}</span>
                <div className="h-[6px] rounded-full bg-line overflow-hidden flex-1">
                  <div className="h-full" style={{ width: `${Math.min(100, r.pct)}%`, background: status.color }} />
                </div>
                <span className="w-12 text-right text-muted">{r.used.toLocaleString()}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ---------- DHCP leases ----------

function DhcpLeases({ dhcp }) {
  const rows = dhcp.data?.rows ?? []
  const top = rows.slice(0, 12)

  return (
    <Card span={6} title="DHCP Leases" right={<span className="text-[11px] text-muted">{rows.length.toLocaleString()} total · first 12 shown</span>}>
      {dhcp.loading ? (
        <Skeleton h={200} />
      ) : dhcp.error || rows.length === 0 ? (
        <Empty />
      ) : (
        <table className="w-full border-collapse mt-2.5 text-sm">
          <thead>
            <tr>
              {['Address', 'Hostname', 'Ends', 'Hardware', 'State'].map((h) => (
                <th key={h} className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {top.map((r, i) => (
              <tr key={r.address || i}>
                <td className="py-2.5 px-2.5 border-b border-line font-mono">{r.address || '—'}</td>
                <td className="py-2.5 px-2.5 border-b border-line">{r.hostname || '—'}</td>
                <td className="py-2.5 px-2.5 border-b border-line font-mono text-muted">{r.ends || '—'}</td>
                <td className="py-2.5 px-2.5 border-b border-line font-mono text-muted">{r.hardware || '—'}</td>
                <td className="py-2.5 px-2.5 border-b border-line text-muted">{r.state || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ---------- exhaustion table ----------

function ExhaustionTable({ subnets }) {
  const [filter, setFilter] = useState('')
  const [site, setSite] = useState('')
  const [sort, setSort] = useState({ key: 'util', dir: 'desc' })

  // /29-/32 are infra links (point-to-point/loopback), always ~100% — exclude,
  // they'd bury real exhaustion (old app: 67db14e)
  const base = useMemo(() => subnets.filter((s) => (Number(s.cidr) || 0) <= 28), [subnets])
  const sites = useMemo(() => [...new Set(base.map((s) => s.site).filter(Boolean))].sort(), [base])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return base.filter((s) => {
      if (site && s.site !== site) return false
      if (!q) return true
      return [s.addr, s.cidr, s.site, s.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [base, filter, site])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    arr.sort((a, b) => {
      let av, bv
      if (key === 'network') { av = a.addr || a.cidr || ''; bv = b.addr || b.cidr || '' }
      else if (key === 'site') { av = a.site || ''; bv = b.site || '' }
      else if (key === 'used') { av = Number(a.used) || 0; bv = Number(b.used) || 0 }
      else if (key === 'free') { av = (Number(a.total) || 0) - (Number(a.used) || 0); bv = (Number(b.total) || 0) - (Number(b.used) || 0) }
      else { av = Number(a.util) || 0; bv = Number(b.util) || 0 }
      if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return dir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [filtered, sort])

  const top20 = sorted.slice(0, 20)

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))
  }

  const headers = [
    { key: 'network', label: 'Network' },
    { key: 'site', label: 'Site' },
    { key: 'util', label: 'Utilization' },
    { key: 'status', label: 'Status', noSort: true },
    { key: 'used', label: 'Used' },
    { key: 'free', label: 'Free' },
  ]

  return (
    <Card
      span={6}
      title="Which Subnets Run Out First?"
      note="excl. /29–/32 infra links"
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-[170px] px-2.5 py-1.5 rounded-lg border border-[#2a2a2a] bg-[#141414] text-[#ddd] text-sm outline-none"
          />
          <select
            value={site}
            onChange={(e) => setSite(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-[#2a2a2a] bg-[#141414] text-[#ddd] text-sm outline-none"
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      }
    >
      {base.length === 0 ? (
        <Empty />
      ) : top20.length === 0 ? (
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
            {top20.map((s, i) => {
              const util = Number(s.util) || 0
              const used = Number(s.used) || 0
              const free = (Number(s.total) || 0) - used
              const status = utilStatus(util)
              const network = s.addr || s.cidr || '—'
              return (
                <tr key={network + i}>
                  <td className="py-2.5 px-2.5 border-b border-line font-mono">{network}</td>
                  <td className="py-2.5 px-2.5 border-b border-line">{s.site || '—'}</td>
                  <td className="py-2.5 px-2.5 border-b border-line" style={{ width: '22%' }}>
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
                  <td className="py-2.5 px-2.5 border-b border-line text-muted">{used.toLocaleString()}</td>
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
