import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, hiddenPanelGroup, Skeleton, useChartTheme, utilStatus } from '../components/ui.jsx'
import { DataTable, sortRows } from '../components/DataTable.jsx'
import { SERVICE_GROUPS, useOwnedServices } from '../lib/services.js'
import { useHashParams, setHashParams } from '../lib/hash.js'
import { DASH, freeOf, num } from '../lib/measured.js'

// A single frozen empty array, shared by every `?? NO_ROWS` fallback below.
// `?? []` builds a NEW array on every render, so any useMemo depending on that
// value recomputed every render and memoized nothing — oxlint reports it as
// "depends on `rows`, which changes every render". One stable reference makes
// the dependency honest instead of suppressing the warning. When data IS
// present the reference is the fetch hook's own array, which is already stable
// between renders, so the memo now works in both states.
const NO_ROWS = Object.freeze([])


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

// Only the utilisation panel needs recharts, so only it waits for it.
const CategoryBars = lazy(() => import('../charts/CategoryBars.jsx'))

export default function Network() {
  const data = useApi('/api/data', { poll: 30000 })
  const ipam = useApi('/api/csp/ipam-util', { poll: 30000 })
  const dhcp = useApi('/api/csp/dhcp-leases', { poll: 30000 })
  const hp = useHashParams()
  // One shared read of /api/service-inventory per page load — see Security.jsx.
  const owned = useOwnedServices()

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
      <h1 className="text-copy font-semibold tracking-tight mb-3">Network</h1>
      {/* Every direct child of a grid with a layoutKey carries its own panelId,
          because CardGrid reads the saved order off `props.panelId` of its own
          children while it reads the live order off the DOM. A wrapper whose id
          only exists on the <Card> inside it is invisible to the first and
          visible to the second, which is exactly the mismatch the guard in
          components/ui.jsx logs. Each wrapper below forwards the id to its
          Card, which is what registers the saved span. */}
      <CardGrid layoutKey="network">
        <UtilBands panelId="network-utilization-distribution" subnets={subnets} totals={totals} subnetsStatus={subnetsStatus} />
        <IpamSpaces panelId="network-ipam-spaces" ipam={ipam} />
        {/* Leases are issued by a deployed DHCP service. The IPAM panels above
            and the subnet table below read address-space config, which exists
            with no DHCP service at all — so neither is mapped.

            hiddenPanelGroup is a function, not a component, so each panel in
            the run stays a direct child of the grid and keeps its own panelId —
            see its comment in components/ui.jsx for why that matters to a saved
            layout. The id lives here rather than on the <Card> inside
            DhcpLeases for the same reason it does on Overview: the grid reads
            it off this element. */}
        {hiddenPanelGroup({
          ...SERVICE_GROUPS.dhcp,
          state: owned,
          children: [
            <DhcpLeases key="network-dhcp-leases" panelId="network-dhcp-leases" dhcp={dhcp} innerRef={leasesRef} />,
          ],
        })}
        <ExhaustionTable panelId="network-exhaustion" subnets={subnets} hp={hp} subnetsStatus={subnetsStatus} />
      </CardGrid>
    </div>
  )
}

// ---------- utilization distribution ----------

function UtilBands({ panelId, subnets, totals, subnetsStatus }) {
  const { COLORS } = useChartTheme()
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
    <Card panelId={panelId} span={3} title="Utilization Distribution" right={<span className="text-note text-muted">{scopeLabel}</span>}>
      {!hasData ? (
        subnetsStatus === 'error' ? (
          <FeedUnavailable label="Subnets feed unavailable" />
        ) : subnets.length > 0 ? (
          <Empty>no loaded subnet reports utilisation</Empty>
        ) : (
          <Empty />
        )
      ) : (
        /* Already said "<70% · 486 subnets" before ChartTip existed; that
           tooltip now lives in charts/CategoryBars.jsx along with the bars. */
        <Suspense fallback={<Skeleton h={220} />}>
          <CategoryBars data={counts} unit="subnets" height={220} xKey="label" showY />
        </Suspense>
      )}
    </Card>
  )
}

// ---------- IPAM spaces ----------

const IPAM_SPACES_CAP = 12

function IpamSpaces({ panelId, ipam }) {
  // A space whose feed reports no total has no capacity to be "top used" against,
  // so it is not ranked. Those are dropped by the filter; everything that
  // survives it is what the cap below is measured against, so the label states a
  // denominator that was actually counted rather than the raw feed length.
  const eligible = (ipam.data?.rows ?? NO_ROWS)
    .filter((r) => (Number(r.total) || 0) > 0)
    .map((r) => ({ ...r, used: Number(r.used) || 0, total: Number(r.total) || 0, pct: ((Number(r.used) || 0) / (Number(r.total) || 1)) * 100 }))
    .sort((a, b) => b.used - a.used)
  const rows = eligible.slice(0, IPAM_SPACES_CAP)
  // The cap was silent until 2026-08-19: against the live tenant this ranked 31
  // spaces and drew 12, and the panel said only "addresses used" — so 19 spaces
  // were missing with nothing on screen admitting it. Same wording as Overview's
  // "top 12 of N subnets", which is this repo's standard for a capped ranking.
  const capLabel = eligible.length > rows.length ? `top ${rows.length} of ${eligible.length.toLocaleString()}` : null
  // CSPIpamUtil returns status:"error" at HTTP 200 on an upstream failure —
  // the fetch itself never errors, so `ipam.error` alone never catches this.
  const status = ipam.data?.status

  return (
    <Card panelId={panelId} span={3} title="IPAM Spaces — Top Used" right={<span className="text-note text-muted">addresses used{capLabel ? ` · ${capLabel}` : ''}</span>}>
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
              <div key={`${r.id ?? r.label ?? ''}|${i}`} className="flex items-center gap-2 text-note">
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

function DhcpLeases({ panelId, dhcp, innerRef }) {
  const hp = useHashParams()
  const rows = dhcp.data?.rows ?? NO_ROWS
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
    // No wrapper div. The span must live on the GRID ITEM, and with the wrapper
    // gone the Card is that item — span={6} puts SPAN_CLASS[6]
    // ("col-span-2 md:col-span-4 xl:col-span-6") on the Card's own element, the
    // exact class the wrapper used to carry, so the rendered width is unchanged.
    // The wrapper had to go for two reasons: a plain div carrying the span class
    // is one of the two shapes CardGrid's layoutKey guard rejects, because the
    // panelId it can see on the DOM is not on the child it sorts; and once this
    // tile is hidden the Card renders null while the div stayed a grid item,
    // holding a blank gap open where the panel used to be. `innerRef` is Card's
    // own ref-forwarding prop, so #network?focus=leases still scrolls here.
    <Card
      innerRef={innerRef}
      panelId={panelId}
      span={6}
      title="DHCP Leases"
      right={
        <div className="flex items-center gap-2">
          <span className="text-note text-muted">{filtered.length.toLocaleString()} of {rows.length.toLocaleString()}</span>
          <input
            aria-label="Search address, hostname, MAC"
            placeholder="Search address, hostname, MAC…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={`${FIELD_CLS} w-[220px]`}
          />
          <select
            aria-label="Filter by state"
            value={state}
            onChange={(e) => setState(e.target.value)}
            className={FIELD_CLS}
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

// The cap this table is actually drawn at, named so panelHelpValues.test.js can
// bind the help sentence to it — the same arrangement as DNSSEC_CAP in Dns.jsx.
// It is handed to DataTable rather than applied here on purpose: DataTable can
// only print "showing N of M" over the rows it is given, so a slice upstream of
// it is a cap nothing can label.
const EXHAUSTION_CAP = 150

function ExhaustionTable({ panelId, subnets, hp, subnetsStatus }) {
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

  // NO cap is applied here, deliberately. This used to be `sorted.slice(0, 20)`,
  // and the 20 was invisible: DataTable only prints its "showing N of M" footer
  // over the rows it is HANDED, so slicing upstream meant it was handed 20,
  // 20 < its rowCap of 150, and it correctly reported no truncation. Against the
  // live tenant that hid 467 of the 487 loaded subnets behind a panel whose whole
  // job is to say which ones run out first, with the filter and site controls
  // right there implying the rest could be reached. Measured 2026-08-19.
  //
  // The full sorted set goes to DataTable instead, which caps at rowCap={150}
  // below and labels that cap itself — the same arrangement the leases table
  // twenty lines up already uses, and the repo's standard everywhere else.

  // Normalize numerics + derive network/free so column keys match sort keys.
  // util/used/free stay null when unmeasured — every cell below renders that
  // as —, and utilStatus() is never asked to grade it.
  const tableRows = useMemo(
    () =>
      sorted.map((s) => ({
        ...s,
        util: num(s.util),
        used: num(s.used),
        free: freeOf(s),
        network: s.addr || s.cidr || '—',
      })),
    [sorted],
  )

  // Controlled sort: DataTable renders header arrows + reports clicks; the
  // component still owns sorting.
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
          return <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium bg-line text-muted">Unknown</span>
        }
        const status = utilStatus(r.util)
        return (
          <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: status.bg, color: status.fg }}>
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
      panelId={panelId}
      span={6}
      // The heading is a fragment — it carries a clear-filter chip when the tab
      // has been drilled into — and a fragment is not a name, so "Arrange this
      // page" listed this panel as "network-exhaustion". The words are the
      // heading's own, minus the chip.
      panelName="Which Subnets Run Out First?"
      title={
        <>
          Which Subnets Run Out First?
          {minUtil !== null && (
            <button
              type="button"
              aria-label="Clear filter"
              className="ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-note font-normal bg-field border border-border text-muted cursor-pointer"
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
            aria-label="Filter networks"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${FIELD_CLS} w-[170px]`}
          />
          <select
            aria-label="Filter by site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            className={FIELD_CLS}
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
      ) : tableRows.length === 0 ? (
        <Empty>no subnets match</Empty>
      ) : (
        <div className="mt-2.5">
          <DataTable rows={tableRows} columns={columns} sort={sort} onSort={onSort} maxHeight={420} rowCap={EXHAUSTION_CAP} />
        </div>
      )}
    </Card>
  )
}
