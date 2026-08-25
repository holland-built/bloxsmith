import { lazy, Suspense, useMemo, useState } from 'react'
import { useApi } from '../lib/api.js'
import { sliceState } from '../lib/data.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, FOCUS_RING, Skeleton, useChartTheme } from '../components/ui.jsx'
import { DataTable, FeedCard, statusBadgeColor } from '../components/DataTable.jsx'
import { useThemeColors } from '../lib/theme.jsx'
import { useHashParams } from '../lib/hash.js'

// ---------- helpers ----------

// Matches the guard pattern used by Security.jsx's fmtDate; uses toLocaleString
// (date + time) instead of date-only since job timestamps need time precision.
function fmtDate(v) {
  if (!v) return '—'
  const ms = new Date(v).getTime()
  return isNaN(ms) ? '—' : new Date(ms).toLocaleString()
}

// Per-slice status for a RAW useApi('/api/data') read.
//
// This tab reads the route directly, so it does not get the honesty rule that
// ui/src/lib/data.js applies for useData() tabs. Without it, a request that
// fails outright (a 500, or the cold-request abort) leaves data.data null =>
// _meta {} => the slice status undefined => every `=== 'error'` branch below
// falls through to <Empty/>, i.e. "you have no hosts" for a read that never
// happened. Same rule as lib/data.js: requested but missing => 'error', whether
// the whole request died or the payload came back without the slice.
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

export default function Infra() {
  const data = useApi('/api/data', { poll: 30000 })
  const health = useApi('/api/csp/host-health', { poll: 15000 })
  const onprem = useApi('/api/csp/onprem-hosts', { poll: 30000 })
  const jobs = useApi('/api/csp/jobs', { poll: 15000 })
  const dfp = useApi('/api/csp/dfp', { poll: 30000 })
  const maint = useApi('/api/csp/maintenance', { poll: 60000 })
  const discovery = useApi('/api/csp/discovery-status', { poll: 60000 })
  // The DNS/DHCP/Security service rollup. Registered since the Go rewrite and
  // called by nothing until #152: no panel anywhere showed it, and
  // /api/service-inventory — the same underlying detail_services read — was used
  // only to decide which panels to HIDE, never to say whether those services are
  // actually up.
  const svcHealth = useApi('/api/hub/health', { poll: 30000 })

  const theme = useThemeColors()
  const hp = useHashParams()
  const hosts = data.data?.hosts ?? []
  const totalHosts = data.data?._totals?.hosts
  const hostsStatus = feedStatus(data, 'hosts')
  const dataLoading = data.loading && !data.data
  const maintEnabled = maint.data?.enabled
  const maintOk = maint.data?.status !== 'error' && !maint.error && maintEnabled != null

  return (
    <div className="w-full px-6 py-5">
      <div className="flex items-center gap-2 mb-3">
        <h1 className="text-copy font-semibold tracking-tight">Infrastructure</h1>
        {maintOk && (
          <span
            className="text-note font-medium px-2 py-0.5 rounded-full"
            style={{
              background: maintEnabled ? theme.pillWarnBg : theme.pillOkBg,
              color: maintEnabled ? theme.pillWarnFg : theme.pillOkFg,
            }}
          >
            {maintEnabled ? 'Maintenance ON' : 'Operational'}
          </span>
        )}
      </div>
      {/* The panelIds sit on the call sites, not only on the Card each wrapper
          returns: CardGrid reads panelId off its OWN direct children to apply a
          saved order, and a wrapper that keeps the id inside is invisible to
          that read. Each wrapper forwards it to its Card unchanged. */}
      <CardGrid layoutKey="infra">
        <ServiceHealth panelId="infra-service-health" feed={svcHealth} />
        <HostStatus panelId="infra-host-status" hosts={hosts} totalHosts={totalHosts} hostsStatus={hostsStatus} loading={dataLoading} />
        <FeedCard
          span={2}
          panelId="infra-host-health"
          title="Host Health"
          note="CSP"
          feed={health}
          count
          columns={[
            // Card is narrow (measured ~457px); Status/Version already fit, so
            // Name absorbs the leftover width and clips the longest tokens —
            // there's no room to give it more.
            { key: 'name', label: 'Name', grow: true },
            { key: 'status', label: 'Status', badge: true },
            { key: 'version', label: 'Version', mono: true },
          ]}
        />
        <FeedCard
          span={2}
          panelId="infra-onprem-hosts"
          title="On-Prem Hosts"
          note="CSP"
          feed={onprem}
          limit={5}
          viewAllHref="#infra"
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'ophid', label: 'OPH ID', mono: true },
            { key: 'app_count', label: 'Apps', mono: true },
          ]}
        />
        <DiscoveryStatus panelId="infra-asset-discovery" feed={discovery} />
        <HostTable panelId="infra-host-inventory" hosts={hosts} status={hp.status} totalHosts={totalHosts} hostsStatus={hostsStatus} loading={dataLoading} />
        <FeedCard
          span={3}
          panelId="infra-jobs"
          title="Jobs"
          note="recent"
          feed={jobs}
          count
          columns={[
            { key: 'created_at', label: 'Created', mono: true, render: (v) => fmtDate(v) },
            { key: 'type', label: 'Type', grow: true },
            { key: 'status', label: 'Status', badge: true },
            // Opaque service-principal string; maxCh is a measured ceiling, not a guess.
            { key: 'user', label: 'User', maxCh: 20 },
          ]}
        />
        <FeedCard
          span={3}
          panelId="infra-dfp-services"
          title="DFP Services"
          note="CSP"
          feed={dfp}
          count
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status', badge: true },
          ]}
        />
      </CardGrid>
    </div>
  )
}

// ---------- host status ----------

// The donut is the only thing on this tab that needs recharts, so it is the only
// thing that waits for it. See charts/StatusDonut.jsx for the measurement
// this is based on.
const StatusDonut = lazy(() => import('../charts/StatusDonut.jsx'))

function HostStatus({ hosts, totalHosts, hostsStatus, loading, panelId }) {
  const { COLORS } = useChartTheme()
  // Buckets come from the same statusBucket() the table sorts and filters by,
  // so one host cannot be "Other" here and "unknown" there. Unknown is its own
  // slice rather than part of Other: a host whose status the upstream never
  // reported is not a category of health, and burying 52-of-532 in "Other"
  // hides exactly the population an operator needs to go look at.
  const buckets = { Active: 0, Degraded: 0, Offline: 0, Unknown: 0, Other: 0 }
  for (const h of hosts) buckets[BUCKET_LABEL[statusBucket(h.status)]]++
  const colorMap = {
    Active: COLORS.accent,
    Degraded: COLORS.warn,
    Offline: COLORS.crit,
    Unknown: COLORS.other,
    Other: COLORS.purple,
  }
  // Headline uses the real estate total when the backend has it; the pie is
  // always built from the fetched rows only (loaded !== estate), so its
  // slices are shown as a % of rows loaded, never scaled to invent the gap.
  const loaded = hosts.length
  const total = totalHosts ?? loaded
  const partial = totalHosts != null && totalHosts !== loaded
  const pieData = Object.entries(buckets)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value, color: colorMap[name] }))

  return (
    <Card span={2} panelId={panelId} title="Host Status">
      {loading ? (
        // An unfinished read is neither "no hosts" nor a dead feed.
        <Skeleton h={130} />
      ) : hostsStatus === 'error' && loaded === 0 ? (
        // Checked BEFORE the zero test: a dead read has no total, and printing
        // the empty state for it claims an estate with no hosts in it.
        <FeedUnavailable label="Hosts feed unavailable" />
      ) : total === 0 ? (
        <Empty />
      ) : (
        <div className="flex items-center gap-4">
          <div className="relative w-[130px] h-[130px] shrink-0">
            {/* No skeleton in the fallback: the ring sits under an absolutely
                positioned count that is already legible on its own, so a grey
                bar flashing behind it would be more movement than the empty
                space it replaces. The box keeps its 130px either way. */}
            <Suspense fallback={<div className="w-full h-full" />}>
              <StatusDonut data={pieData} unit="hosts" />
            </Suspense>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-copy font-semibold">{total.toLocaleString()}</span>
              <span className="text-dim text-note">{totalHosts == null ? 'hosts (loaded)' : 'hosts'}</span>
            </div>
          </div>
          <div className="flex-1 flex flex-col gap-2">
            {pieData.map((d) => (
              <div key={d.name} className="flex items-center gap-1.5 text-note">
                <i className="w-2 h-2 rounded-mark inline-block" style={{ background: d.color }} />
                <span className="text-muted flex-1">{d.name}</span>
                <b>{((d.value / loaded) * 100).toFixed(0)}%</b>
              </div>
            ))}
            {partial && (
              <div className="text-dim text-note leading-tight">
                breakdown of {loaded.toLocaleString()} loaded of {total.toLocaleString()} total
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

// ---------- asset discovery status ----------

// One Card, four bodies. This used to be four early-return Cards with the same
// title; they were collapsed because a panelId is a panel's identity, and the
// same panel in four states must not claim four identities (the help scanner
// checks ids are unique, and Card writes the id into the DOM).
// The branch ORDER is unchanged and load-bearing: an unfinished read is not a
// dead feed, and a dead feed is not a tenant with nothing discovered.
function DiscoveryStatus({ feed, panelId }) {
  const { COLORS } = useChartTheme()
  const { data, error, loading } = feed

  const pending = loading && !data
  const dead = !pending && (error || data?.status === 'error')
  const blank = !pending && !dead && (data?.status === 'empty' || !data?.total)
  const ok = !pending && !dead && !blank

  return (
    <Card
      span={2}
      panelId={panelId}
      title="Asset Discovery"
      note={ok ? 'CSP' : undefined}
      right={ok && !data.breakdown_available && data.note ? (
        <span className="text-note text-dim">{data.note}</span>
      ) : undefined}
    >
      {pending ? (
        <Skeleton />
      ) : dead ? (
        <FeedUnavailable label="Asset discovery unavailable" />
      ) : blank ? (
        <Empty>no discovery data for this tenant</Empty>
      ) : (
        <div>
          <span className="text-copy font-semibold" style={{ color: COLORS.accent }}>{data.total.toLocaleString()}</span>
          <span className="text-dim text-note ml-1.5">assets with discovery status tracked</span>
        </div>
      )}
    </Card>
  )
}

// ---------- host inventory table ----------

// "unknown" is the backend's word for a host whose upstream status was absent
// or unrecognised (norm.go). It used to be reported as "pending" — a real
// lifecycle state an operator acts on — so it gets its own bucket everywhere
// and is never folded back into pending, active or offline.
function statusBucket(s) {
  s = s || ''
  if (/^unknown$/i.test(s)) return 'unknown'
  if (/online|up|active/i.test(s)) return 'active'
  if (/degraded|warn/i.test(s)) return 'degraded'
  if (/off|down|error|fail/i.test(s)) return 'offline'
  return 'other'
}

const BUCKET_LABEL = { active: 'Active', degraded: 'Degraded', offline: 'Offline', unknown: 'Unknown', other: 'Other' }

// Severity rank for status sort: offline first, then degraded, then unknown,
// then active, then other. Unknown sorts ABOVE healthy because "we could not
// tell" is a thing to go and check, and BELOW degraded because it is not a
// confirmed fault.
const SEV_ORDER = { offline: 0, degraded: 1, unknown: 2, active: 3, other: 4 }
function sevRank(s) {
  return SEV_ORDER[statusBucket(s)] ?? 4
}

// Status badge. Same pill as DataTable's own `badge` renderer for every status
// it knows; an unknown one is deliberately not one of those colours — neutral
// grey and italic, so it never reads as the green of a healthy host or the
// amber of a pending one, and it carries why in its tooltip.
function renderStatus(v) {
  if (statusBucket(v) === 'unknown') {
    return (
      <span
        className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium italic"
        style={{ background: 'var(--pill-neutral-bg)', color: 'var(--pill-neutral-fg)' }}
        title="upstream reported no status for this host"
      >
        unknown
      </span>
    )
  }
  const st = statusBadgeColor(v) || { bg: 'var(--pill-neutral-bg)', fg: 'var(--pill-neutral-fg)' }
  return (
    <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: st.bg, color: st.fg }}>
      {v || '—'}
    </span>
  )
}

// Octet-aware IP compare.
function ipCompare(a, b) {
  const av = String(a || '').split('.').map(Number)
  const bv = String(b || '').split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) - (bv[i] || 0)
  }
  return 0
}

const HOST_COLUMNS = [
  { key: 'name', label: 'Name', sortable: true, keep: true },
  { key: 'ip', label: 'IP', mono: true, sortable: true, comparator: (a, b) => ipCompare(a.ip, b.ip) },
  // badge stays set so the column keeps its badge width measurement; render
  // takes precedence over it for the actual cell.
  { key: 'status', label: 'Status', badge: true, sortable: true, render: (v) => renderStatus(v), comparator: (a, b) => sevRank(a.status) - sevRank(b.status) },
  { key: 'type', label: 'Type', priority: 'low' },
]

function HostTable({ hosts, status, totalHosts, hostsStatus, loading, panelId }) {
  const theme = useThemeColors()
  const [filter, setFilter] = useState('')
  const [type, setType] = useState('')

  const statusFilter = status === 'error' ? 'offline' : status

  const types = useMemo(() => [...new Set(hosts.map((h) => h.type).filter(Boolean))].sort(), [hosts])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return hosts.filter((h) => {
      if (statusFilter && statusBucket(h.status) !== statusFilter) return false
      if (type && h.type !== type) return false
      if (!q) return true
      return [h.name, h.ip, h.status, h.type].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [hosts, filter, type, statusFilter])

  const feedDead = hostsStatus === 'error' && hosts.length === 0
  const total = totalHosts ?? hosts.length
  // A dead read knows no counts. "0 hosts" is a claim about the estate; "—" is
  // the truth, which is that nothing came back to count.
  const countLabel = feedDead
    ? '— hosts'
    : filtered.length === hosts.length
      ? (totalHosts != null && totalHosts !== hosts.length
          ? `${hosts.length.toLocaleString()} loaded of ${total.toLocaleString()} hosts`
          : `${hosts.length.toLocaleString()} hosts`)
      : `${filtered.length.toLocaleString()} of ${hosts.length.toLocaleString()} loaded (${total.toLocaleString()} total)`

  return (
    <Card
      span={6}
      panelId={panelId}
      // Same shape as Dns.jsx's zone table: the heading turns into a React node
      // while a status filter is on, so the popup's row for this panel flipped
      // between "Host Inventory" and the raw "infra-host-inventory" depending
      // on how the tab had been drilled into.
      panelName="Host Inventory"
      title={
        statusFilter ? (
          <span className="inline-flex items-center gap-2">
            Host Inventory
            {/* A <span onClick> with no role, no tabIndex and no key handler:
                the only way to clear the status filter was a mouse. A real
                <button> is the whole fix — it brings the role, the tab stop and
                Enter/Space with it, and the ✕ stops being the accessible name. */}
            <button
              type="button"
              onClick={() => { location.hash = 'infra' }}
              // NOT aria-label. The panel chrome's About/Hide/Move buttons are
              // aria-labelledby the panel TITLE, and this button is inside it,
              // so an aria-label here is hoisted into all three of their
              // accessible names: measured, "Hide Host Inventory" became "Hide
              // Host Inventory Clear the offline status filter". The visible
              // text is the name instead, and `title` carries the verb.
              title="Clear this filter"
              className={`text-note font-medium px-2 py-0.5 rounded-full cursor-pointer outline-none ${FOCUS_RING}`}
              style={{ background: theme.pillNeutralBg, color: theme.pillNeutralFg }}
            >
              status: {statusFilter} <span aria-hidden="true">✕</span>
            </button>
          </span>
        ) : 'Host Inventory'
      }
      right={
        <div className="flex items-center gap-2">
          <span className="text-note text-muted">{countLabel}</span>
          <input
            placeholder="Search name, IP…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${FIELD_CLS} w-[170px]`}
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={FIELD_CLS}
          >
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      }
    >
      {loading ? (
        <Skeleton h={220} />
      ) : feedDead ? (
        <FeedUnavailable label="Hosts feed unavailable" />
      ) : hosts.length === 0 ? (
        <Empty />
      ) : filtered.length === 0 ? (
        <Empty>no hosts match</Empty>
      ) : (
        <div className="mt-2.5">
          <DataTable
            rows={filtered}
            columns={HOST_COLUMNS}
            maxHeight={420}
            rowCap={150}
            stickyHeader
            rowKey={(h, i) => `${h.name}|${h.ip}|${i}`}
          />
        </div>
      )}
    </Card>
  )
}

// ---------- service health (hub/health) ----------

// Three buckets — DNS, DHCP, Security — rolled up from the deployed services.
// go/internal/dashboard/hub.go builds them and distinguishes four states, and
// all four have to survive the trip to the screen or the panel is worse than
// nothing:
//
//   ok/warn/crit  a measured severity, from the worst member's composite_status
//   unknown       the service list was truncated at its row cap, so this
//                 bucket's services MAY exist past the cap. Not "0 deployed" —
//                 nobody counted to zero.
//   availability  "error" on the whole list means the feed is dead, which must
//                 never render as three healthy buckets
//
// The Go side already refuses to fabricate a healthy rollup; this is the half
// that refuses to draw one.
function ServiceHealth({ panelId, feed }) {
  const theme = useThemeColors()
  const rows = Array.isArray(feed.data) ? feed.data : []
  // Every bucket carries its own availability, and the whole feed is dead only
  // when all of them say so — which is exactly how the Go side marks a failed
  // detail_services read. A transport failure has no body at all.
  const dead = !feed.loading && (!!feed.error || (rows.length > 0 && rows.every((b) => b.availability === 'error')))

  const pill = (status) => {
    if (status === 'ok') return { background: theme.pillOkBg, color: theme.pillOkFg }
    if (status === 'warn') return { background: theme.pillWarnBg, color: theme.pillWarnFg }
    if (status === 'crit' || status === 'error') return { background: theme.pillCritBg, color: theme.pillCritFg }
    // "unknown" and anything a future Go change adds. A neutral badge is the
    // only honest rendering of a state this file does not recognise; colouring
    // it green by falling through would be the bug this panel exists to avoid.
    return { background: theme.pillNeutralBg, color: theme.pillNeutralFg }
  }

  return (
    <Card panelId={panelId} span={2} title="Service Health" note="deployed services">
      {feed.loading ? (
        <Skeleton h={160} />
      ) : dead ? (
        <FeedUnavailable label="Service inventory unavailable" />
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="flex flex-col gap-2 mt-1">
          {rows.map((b) => (
            <div key={b.name} className="flex items-center justify-between gap-2 py-1.5">
              <span className="text-copy font-medium text-txt">{b.name}</span>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-note text-muted truncate" title={b.reason || undefined}>{b.meta}</span>
                <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium whitespace-nowrap" style={pill(b.status)}>
                  {b.statusLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
