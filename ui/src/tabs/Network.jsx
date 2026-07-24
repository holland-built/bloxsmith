import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, CardGrid, Empty, Skeleton, utilStatus } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useHashParams, setHashParams } from '../lib/hash.js'

// IP address octet-order comparator (ascending); DataTable applies direction.
function ipCompare(a, b) {
  const av = (a.address || '').split('.').map(Number)
  const bv = (b.address || '').split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) - (bv[i] || 0)
  }
  return 0
}

// ---------- main ----------

export default function Network() {
  const data = useApi('/api/data', { poll: 30000 })
  const ipam = useApi('/api/csp/ipam-util', { poll: 30000 })
  const dhcp = useApi('/api/csp/dhcp-leases', { poll: 30000 })
  const hp = useHashParams()

  const subnets = data.data?.subnets ?? []

  const leasesRef = useRef(null)
  useEffect(() => {
    if (hp.focus === 'leases' && leasesRef.current) {
      leasesRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [hp.focus])

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Network</h1>
      <CardGrid>
        <UtilBands subnets={subnets} />
        <IpamSpaces ipam={ipam} />
        <DhcpLeases dhcp={dhcp} innerRef={leasesRef} />
        <ExhaustionTable subnets={subnets} hp={hp} />
      </CardGrid>
    </div>
  )
}

// ---------- utilization distribution ----------

function UtilBands({ subnets }) {
  const { TT } = useChartTheme()
  const BANDS = [
    { key: '0-70', label: '<70%', test: (u) => u < 70, color: 'var(--color-accent)' },
    { key: '70-85', label: '70–85%', test: (u) => u >= 70 && u <= 85, color: 'var(--color-warn)' },
    { key: '85-100', label: '>85%', test: (u) => u > 85, color: 'var(--color-crit)' },
  ]
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
            <CartesianGrid stroke="var(--color-grid)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: 'var(--color-tick)', fontSize: 11 }} axisLine={{ stroke: 'var(--color-grid)' }} tickLine={false} />
            <YAxis tick={{ fill: 'var(--color-tick)', fontSize: 11 }} axisLine={{ stroke: 'var(--color-grid)' }} tickLine={false} allowDecimals={false} />
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
              <div key={`${r.id ?? r.label ?? ''}|${i}`} className="flex items-center gap-2 text-xs">
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

function DhcpLeases({ dhcp, innerRef }) {
  const hp = useHashParams()
  const rows = dhcp.data?.rows ?? []
  const [q, setQ] = useState(hp.lease || '')
  const [state, setState] = useState('')

  useEffect(() => {
    if (hp.lease) setQ(hp.lease)
  }, [hp.lease])

  const states = useMemo(() => [...new Set(rows.map((r) => r.state).filter(Boolean))].sort(), [rows])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (state && r.state !== state) return false
      if (!needle) return true
      return [r.address, r.hostname, r.hardware].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))
    })
  }, [rows, q, state])

  // Precompute ends timestamp + display label; default order is ends-desc.
  const tableRows = useMemo(() => {
    return filtered
      .map((r) => {
        const ms = r.ends ? new Date(r.ends).getTime() : NaN
        return {
          ...r,
          _endsMs: isNaN(ms) ? 0 : ms,
          endsLabel: !isNaN(ms) ? new Date(ms).toLocaleString() : r.ends || '—',
        }
      })
      .sort((a, b) => b._endsMs - a._endsMs)
  }, [filtered])

  const columns = [
    { key: 'address', label: 'Address', mono: true, sortable: true, comparator: ipCompare },
    { key: 'hostname', label: 'Hostname', sortable: true },
    { key: 'endsLabel', label: 'Ends', mono: true, sortable: true, comparator: (a, b) => (a._endsMs || 0) - (b._endsMs || 0) },
    { key: 'hardware', label: 'Hardware', mono: true, clip: 160, priority: 'low', sortable: true },
    { key: 'state', label: 'State', sortable: true },
  ]

  return (
    // span must live on the grid item — a bare wrapper div here collapsed the card;
    // class must match SPAN_CLASS[6] in ui.jsx so it reflows with the rest of the grid
    <div ref={innerRef} className="col-span-2 md:col-span-4 xl:col-span-6">
    <Card
      span={6}
      title="DHCP Leases"
      right={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">{filtered.length.toLocaleString()} of {rows.length.toLocaleString()}</span>
          <input
            placeholder="Search address, hostname, MAC…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-[220px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          >
            <option value="">All states</option>
            {states.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      }
    >
      {dhcp.loading ? (
        <Skeleton h={200} />
      ) : dhcp.error || rows.length === 0 ? (
        <Empty />
      ) : tableRows.length === 0 ? (
        <Empty>no leases match</Empty>
      ) : (
        <div className="mt-2.5">
          <DataTable rows={tableRows} columns={columns} maxHeight={420} rowCap={150} stickyHeader emptyText="no leases match" />
        </div>
      )}
    </Card>
    </div>
  )
}

// ---------- exhaustion table ----------

function ExhaustionTable({ subnets, hp }) {
  const [filter, setFilter] = useState(hp.subnet || '')
  const [site, setSite] = useState('')
  const [sort, setSort] = useState({ key: 'util', dir: 'desc' })
  const minUtil = hp.minUtil !== undefined && hp.minUtil !== '' ? Number(hp.minUtil) : null

  useEffect(() => {
    if (hp.subnet) setFilter(hp.subnet)
  }, [hp.subnet])

  // /29-/32 are infra links (point-to-point/loopback), always ~100% — exclude,
  // they'd bury real exhaustion (old app: 67db14e)
  const base = useMemo(() => subnets.filter((s) => (Number(s.cidr) || 0) <= 28), [subnets])
  const sites = useMemo(() => [...new Set(base.map((s) => s.site).filter(Boolean))].sort(), [base])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return base.filter((s) => {
      if (site && s.site !== site) return false
      if (minUtil !== null && (Number(s.util) || 0) < minUtil) return false
      if (!q) return true
      return [s.addr, s.cidr, s.site, s.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [base, filter, site, minUtil])

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

  // Normalize numerics + derive network/free so column keys match sort keys.
  const tableRows = useMemo(
    () =>
      top20.map((s) => {
        const util = Number(s.util) || 0
        const used = Number(s.used) || 0
        const free = (Number(s.total) || 0) - used
        return { ...s, util, used, free, network: s.addr || s.cidr || '—' }
      }),
    [top20],
  )

  // Controlled sort: DataTable renders header arrows + reports clicks; the
  // component still owns sorting (sort full set -> slice top20).
  function onSort(next) {
    setSort((s) => (s.key === next.key ? { key: next.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: next.key, dir: 'desc' }))
  }

  const columns = [
    { key: 'network', label: 'Network', mono: true, sortable: true },
    { key: 'site', label: 'Site', sortable: true },
    {
      key: 'util',
      label: 'Utilization',
      sortable: true,
      width: '22%',
      render: (_v, r) => {
        const status = utilStatus(r.util)
        return (
          <div className="flex items-center gap-2">
            <div className="h-[5px] rounded-full bg-line overflow-hidden flex-1 min-w-[70px]">
              <div className="h-full" style={{ width: `${Math.min(100, r.util)}%`, background: status.color }} />
            </div>
            <span className="text-muted w-9 text-right">{r.util}%</span>
          </div>
        )
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: (_v, r) => {
        const status = utilStatus(r.util)
        return (
          <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: status.bg, color: status.fg }}>
            {status.label}
          </span>
        )
      },
    },
    { key: 'used', label: 'Used', align: 'right', sortable: true, render: (v) => <span className="text-muted">{(Number(v) || 0).toLocaleString()}</span> },
    { key: 'free', label: 'Free', align: 'right', sortable: true, render: (v) => <span className="text-muted">{(Number(v) || 0).toLocaleString()} free</span> },
  ]

  return (
    <Card
      span={6}
      title={
        <>
          Which Subnets Run Out First?
          {minUtil !== null && (
            <span
              className="ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-normal bg-field border border-border text-muted cursor-pointer"
              onClick={() => setHashParams('network', {})}
              title="clear filter"
            >
              util ≥ {minUtil}% ✕
            </span>
          )}
        </>
      }
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
        </div>
      }
    >
      {base.length === 0 ? (
        <Empty />
      ) : top20.length === 0 ? (
        <Empty>no subnets match</Empty>
      ) : (
        <div className="mt-2.5">
          <DataTable rows={tableRows} columns={columns} sort={sort} onSort={onSort} maxHeight={420} rowCap={150} />
        </div>
      )}
    </Card>
  )
}
