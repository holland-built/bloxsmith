import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, Skeleton, utilStatus } from '../components/ui.jsx'
import { DataTable, sortRows } from '../components/DataTable.jsx'
import { useThemeColors } from '../lib/theme.jsx'
import { useHashParams, setHashParams } from '../lib/hash.js'

// A number the backend actually measured, or null when it did not.
//
// go/internal/dashboard/norm.go emits JSON null — not 0 — for util/total/used
// on a subnet whose upstream row reports no total. `Number(x) || 0` turns that
// null into a healthy-looking 0%, i.e. "this subnet is empty", which is
// precisely the claim we cannot make. Everything downstream carries the null
// instead and renders it as —. Checked against the live tenant: every subnet
// there currently reports a total, so this is a guard, not a live symptom —
// the 295 rows sitting at 0% do report total=0 and are a real measurement.
function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// total - used, or null when either side is unknown: an unknown minus a known
// is not a number of free addresses.
function freeOf(s) {
  const total = num(s.total)
  const used = num(s.used)
  return total === null || used === null ? null : total - used
}

// A count we could not fetch is not a count of zero.
const DASH = '—'

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
  const totals = data.data?._totals
  const meta = data.data?._meta ?? {}

  // The whole /api/data request failed — a 500, or the cold-request abort
  // (measured 17-26s cold against a 12s warm budget). There is then no payload
  // at all: no `_meta`, so every per-slice status is undefined, and every
  // slice reads as [] — which the panels below would render as "you have
  // none" over a dead backend. This is the same rule lib/data.js gives the
  // useData() tabs (see its header: "Requested but missing => 'error'"); this
  // tab reads /api/data raw and so has to apply it itself. The status
  // vocabulary stays exactly ok / empty / error.
  //
  // Not while loading: a request still in flight is a Skeleton, not a failure.
  const feedDown = !data.loading && (!!data.error || data.data == null)
  const subnetsStatus = feedDown ? 'error' : meta.subnets

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
        <UtilBands subnets={subnets} totals={totals} subnetsStatus={subnetsStatus} />
        <IpamSpaces ipam={ipam} />
        <DhcpLeases dhcp={dhcp} innerRef={leasesRef} />
        <ExhaustionTable subnets={subnets} hp={hp} subnetsStatus={subnetsStatus} />
      </CardGrid>
    </div>
  )
}

// ---------- utilization distribution ----------

function UtilBands({ subnets, totals, subnetsStatus }) {
  const { COLORS, TT } = useChartTheme()
  const { grid, tick } = useThemeColors()
  const BANDS = [
    { key: '0-70', label: '<70%', test: (u) => u < 70, color: COLORS.accent },
    { key: '70-85', label: '70–85%', test: (u) => u >= 70 && u <= 85, color: COLORS.warn },
    { key: '85-100', label: '>85%', test: (u) => u > 85, color: COLORS.crit },
  ]
  // A subnet with no reported utilisation belongs in no band — counted as 0 it
  // lands in "<70%" and inflates the healthy bar with subnets nobody measured.
  // It is excluded from the bands and declared in the scope label.
  const measured = subnets.filter((s) => num(s.util) !== null)
  const unmeasured = subnets.length - measured.length
  const counts = BANDS.map((b) => ({
    label: b.label,
    value: measured.filter((s) => b.test(num(s.util))).length,
    color: b.color,
  }))
  const hasData = measured.length > 0
  const estateTotal = Number.isFinite(totals?.subnets) ? totals.subnets : null
  const unmeasuredLabel = unmeasured > 0 ? ` · ${unmeasured.toLocaleString()} util unknown` : ''
  // "0 loaded" over a dead feed reads as an empty estate; the count is
  // unknown, so it prints as an em-dash.
  const scopeLabel = subnetsStatus === 'error'
    ? `${DASH} loaded (count unavailable)`
    : estateTotal !== null
      ? `${subnets.length.toLocaleString()} loaded of ${estateTotal.toLocaleString()} total${unmeasuredLabel}`
      : `${subnets.length.toLocaleString()} loaded (estate total unavailable)${unmeasuredLabel}`

  return (
    <Card span={3} title="Utilization Distribution" right={<span className="text-[11px] text-muted">{scopeLabel}</span>}>
      {!hasData ? (
        subnetsStatus === 'error' ? (
          <FeedUnavailable label="Subnets feed unavailable" />
        ) : subnets.length > 0 ? (
          <Empty>no loaded subnet reports utilisation</Empty>
        ) : (
          <Empty />
        )
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={counts} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: tick, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
            <YAxis tick={{ fill: tick, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} allowDecimals={false} />
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
  // CSPIpamUtil returns status:"error" at HTTP 200 on an upstream failure —
  // the fetch itself never errors, so `ipam.error` alone never catches this.
  const status = ipam.data?.status

  return (
    <Card span={3} title="IPAM Spaces — Top Used" right={<span className="text-[11px] text-muted">addresses used</span>}>
      {ipam.loading ? (
        <Skeleton h={220} />
      ) : ipam.error || status === 'error' ? (
        <FeedUnavailable label="IPAM feed unavailable" />
      ) : rows.length === 0 ? (
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
  // CSPDHCPLeases returns status:"error" at HTTP 200 on an upstream failure —
  // the fetch itself never errors, so `dhcp.error` alone never catches this.
  const status = dhcp.data?.status
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
    { key: 'hostname', label: 'Hostname', grow: true, sortable: true },
    { key: 'endsLabel', label: 'Ends', mono: true, sortable: true, comparator: (a, b) => (a._endsMs || 0) - (b._endsMs || 0) },
    { key: 'hardware', label: 'Hardware', mono: true, priority: 'low', sortable: true },
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
      ) : dhcp.error || status === 'error' ? (
        <FeedUnavailable label="DHCP leases feed unavailable" />
      ) : rows.length === 0 ? (
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

// Where an unknown (null) number sorts: always the BOTTOM of whichever
// direction is on screen. Ordering it as 0 would present an unmeasured subnet
// as the emptiest one; putting it at the top of the default worst-first sort
// would present it as the most exhausted. Neither is known.
//
// MAX_SAFE_INTEGER rather than Infinity because sortRows subtracts the two
// accessor values, and Infinity - Infinity is NaN — a NaN comparator makes
// Array#sort's result implementation-defined.
const UNKNOWN_RANK = Number.MAX_SAFE_INTEGER

// Per-key accessors for the controlled sort; sortRows does the string/number
// branch. Direction-dependent, so it is built per sort rather than frozen.
function exhaustionSort(dir) {
  const unknown = dir === 'asc' ? UNKNOWN_RANK : -UNKNOWN_RANK
  return {
    network: (r) => r.addr || r.cidr || '',
    site: (r) => r.site || '',
    used: (r) => num(r.used) ?? unknown,
    free: (r) => freeOf(r) ?? unknown,
    util: (r) => num(r.util) ?? unknown,
  }
}

function ExhaustionTable({ subnets, hp, subnetsStatus }) {
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
      // An unknown utilisation cannot satisfy "util >= N", so it is excluded
      // explicitly. Counted as 0 it would pass a minUtil of 0 as if measured
      // at zero, and fail every other threshold for the wrong reason.
      if (minUtil !== null) {
        const u = num(s.util)
        if (u === null || u < minUtil) return false
      }
      if (!q) return true
      return [s.addr, s.cidr, s.site, s.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [base, filter, site, minUtil])

  const sorted = useMemo(() => sortRows(filtered, sort, exhaustionSort(sort.dir)), [filtered, sort])

  const top20 = sorted.slice(0, 20)

  // Normalize numerics + derive network/free so column keys match sort keys.
  // util/used/free stay null when unmeasured — every cell below renders that
  // as —, and utilStatus() is never asked to grade it.
  const tableRows = useMemo(
    () =>
      top20.map((s) => ({
        ...s,
        util: num(s.util),
        used: num(s.used),
        free: freeOf(s),
        network: s.addr || s.cidr || '—',
      })),
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
      grow: true,
      render: (_v, r) => {
        const status = r.util === null ? null : utilStatus(r.util)
        return (
          <div className="flex items-center gap-2">
            <div className="h-[5px] rounded-full bg-line overflow-hidden flex-1 min-w-[70px]">
              {/* no bar at all for an unknown util — a zero-width bar and a 0%
                  bar are indistinguishable, and one of them is a lie */}
              {status && <div className="h-full" style={{ width: `${Math.min(100, r.util)}%`, background: status.color }} />}
            </div>
            <span className="text-muted w-9 text-right">{r.util === null ? DASH : `${r.util}%`}</span>
          </div>
        )
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: (_v, r) => {
        // utilStatus(null) answers "Healthy" (null >= 92 and null >= 75 are
        // both false) — a green badge on a subnet nobody measured. Unknown
        // gets its own neutral badge instead.
        if (r.util === null) {
          return <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-line text-muted">Unknown</span>
        }
        const status = utilStatus(r.util)
        return (
          <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: status.bg, color: status.fg }}>
            {status.label}
          </span>
        )
      },
    },
    { key: 'used', label: 'Used', align: 'right', sortable: true, render: (v) => <span className="text-muted">{v === null ? DASH : v.toLocaleString()}</span> },
    { key: 'free', label: 'Free', align: 'right', sortable: true, render: (v) => <span className="text-muted">{v === null ? DASH : `${v.toLocaleString()} free`}</span> },
  ]

  return (
    <Card
      span={6}
      title={
        <>
          Which Subnets Run Out First?
          {minUtil !== null && (
            <button
              type="button"
              aria-label="Clear filter"
              className="ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-normal bg-field border border-border text-muted cursor-pointer"
              onClick={() => setHashParams('network', {})}
              title="clear filter"
            >
              util ≥ {minUtil}% ✕
            </button>
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
        subnetsStatus === 'error' ? <FeedUnavailable label="Subnets feed unavailable" /> : <Empty />
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
