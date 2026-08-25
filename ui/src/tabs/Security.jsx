import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { authFetch } from '../lib/authFetch.js'
import { useChartTheme, Card, CardGrid, Empty, hiddenPanelGroup, Skeleton, FeedUnavailable } from '../components/ui.jsx'
import { fmtShortDay } from '../lib/chartFormat.js'
import { DataTable } from '../components/DataTable.jsx'
import { SERVICE_GROUPS, useOwnedServices } from '../lib/services.js'
import { sampleCountLabel, sampleScopeNote, totalEventsTile } from '../lib/sampleCount.js'
import { DASH } from '../lib/measured.js'
import { inventoryRow } from '../lib/securityInventory.js'

// A single frozen empty array, shared by every `?? NO_ROWS` fallback below.
// `?? []` builds a NEW array on every render, so any useMemo depending on that
// value recomputed every render and memoized nothing — oxlint reports it as
// "depends on `rows`, which changes every render". One stable reference makes
// the dependency honest instead of suppressing the warning. When data IS
// present the reference is the fetch hook's own array, which is already stable
// between renders, so the memo now works in both states.
const NO_ROWS = Object.freeze([])

const SEV_RANK = ['critical', 'high', 'medium', 'low', 'info']
function sevRank(s) {
  const i = SEV_RANK.indexOf(String(s || '').toLowerCase())
  return i < 0 ? 99 : i
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low']

function sevColorMap(COLORS) {
  return { critical: COLORS.crit, high: COLORS.sevHigh, medium: COLORS.warn, low: COLORS.accent }
}

function ackKey(e) {
  return `${e.event_time}|${e.qname}`
}

// ---------- main ----------

// Two chart shapes on this tab; only the panels drawing them wait for recharts.
const CategoryBars = lazy(() => import('../charts/CategoryBars.jsx'))
const StackedDayBars = lazy(() => import('../charts/StackedDayBars.jsx'))

export default function Security() {
  const hub = useApi('/api/hub/security')
  const threats = useApi('/api/csp/threats', { poll: 30000 })
  const lookalikes = useApi('/api/lookalikes')
  // Axur is a separate vendor, deliberately polled far slower than the CSP
  // feeds beside it: the counts cover a 30-day window and move in hours.
  const axur = useApi('/api/axur', { poll: 300000 })
  const insights = useApi('/api/insights')
  const ctem = useApi('/api/csp/ctem-exposure', { poll: 30000 })
  const assetInsights = useApi('/api/csp/asset-insights', { poll: 30000 })
  const exposures = useApi('/api/csp/exposures', { poll: 30000 })
  const assetRisk = useApi('/api/csp/asset-risk', { poll: 30000 })
  const exposedHostnames = useApi('/api/csp/exposed-hostnames', { poll: 30000 })
  const exposedIps = useApi('/api/csp/exposed-ips', { poll: 30000 })
  const ctemAssets = useApi('/api/csp/ctem-assets', { poll: 30000 })
  // The seven-section security rollup. Registered since the Go rewrite and
  // called by nothing until #152. One request, not seven: the Go side fans its
  // upstream reads out concurrently (measured 1.57s -> 0.54s cold), which is
  // what made it affordable on a tab that already holds eleven feeds.
  const hubDomains = useApi('/api/hub/domains', { poll: 60000 })
  const [acks, setAcks] = useState({})
  // One shared read of /api/service-inventory per page load — deliberately not
  // useApi(), which would join the 30s poll above for an answer that cannot
  // change while the page is open.
  const owned = useOwnedServices()

  const events = hub.data?.events ?? []

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Security</h1>
      {/* Every direct child of a grid with a layoutKey carries its own panelId:
          CardGrid applies the saved order to its React children by reading
          `props.panelId` off them, while it reads the live order off the DOM. A
          wrapper whose id only exists on the <Card> inside it is visible to the
          second and invisible to the first, and the panel jumps to the end on
          reload. Each wrapper below forwards the id to its Card. */}
      <CardGrid layoutKey="security">
        {/* All three read /api/hub/security -> dns_event, which the
            forwarding-proxy tier produces. Hidden as one group, and only when
            the inventory read authoritatively says neither dfp nor orpheus is
            deployed. */}
        {hiddenPanelGroup({
          ...SERVICE_GROUPS.threatDefense,
          state: owned,
          children: [
            <SeverityHero key="security-threat-events" panelId="security-threat-events" hub={hub} events={events} />,
            <KpiStack key="security-response-summary" panelId="security-response-summary" hub={hub} events={events} acks={acks} />,
            <TriageInbox key="security-triage-inbox" panelId="security-triage-inbox" hub={hub} events={events} acks={acks} setAcks={setAcks} />,
          ],
        })}
        <SecurityInventory panelId="security-inventory" hub={hubDomains} />
        <LookalikeTable panelId="security-lookalike-domains" lookalikes={lookalikes} />
        <AxurPanel panelId="security-axur-incidents" axur={axur} />
        <CtemPanel panelId="security-ctem-exposure" ctem={ctem} />
        <AssetInsights panelId="security-asset-insights" assetInsights={assetInsights} />
        <ExposuresPanel panelId="security-exposures" exposures={exposures} />
        <AssetRiskPanel panelId="security-asset-risk" assetRisk={assetRisk} />
        <ExposedSurfacePanel panelId="security-exposed-surface" hostnames={exposedHostnames} ips={exposedIps} />
        <CtemAssetsPanel panelId="security-ctem-assets" ctemAssets={ctemAssets} />
        <ThreatFeed panelId="security-threat-feed-activity" threats={threats} />
        <InsightsPanel panelId="security-soc-insights" insights={insights} />
      </CardGrid>
    </div>
  )
}

// ---------- severity hero ----------

function SeverityHero({ panelId, hub, events }) {
  const { COLORS } = useChartTheme()
  const SEV_COLOR = sevColorMap(COLORS)
  const counts = hub.data?.counts ?? {}
  // hub.error covers the transport path (any non-2xx, or the 12s abort in
  // lib/api.js) — availability:"error" alone only covers the upstream-
  // reported failure, missing the case where the fetch itself never completed.
  const unavailable = hub.data?.availability === 'error' || !!hub.error
  const hourly = useMemo(() => {
    const buckets = new Array(24).fill(0)
    let any = false
    for (const e of events) {
      const t = e.event_time
      if (t == null || t === '') continue
      let ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : new Date(t).getTime()
      if (isNaN(ms)) continue
      buckets[new Date(ms).getHours()]++
      any = true
    }
    return any ? buckets.map((v, h) => ({ hour: `${h}:00`, value: v })) : []
  }, [events])
  const scopeNote = sampleScopeNote(hub.data, 'events')

  return (
    <Card panelId={panelId} span={4} title="Threat Events — by Severity" right={unavailable ? null : <span className="text-[11px] text-muted">{sampleCountLabel(hub.data, 'events')}</span>}>
      {hub.loading ? (
        <Skeleton h={230} />
      ) : unavailable ? (
        <FeedUnavailable reason={hub.data?.reason} label="Threat feed unavailable" />
      ) : events.length === 0 ? (
        <Empty />
      ) : (
        <>
          <div className="flex gap-4 mb-3">
            {SEV_ORDER.map((s) => (
              <div key={s} className="flex items-center gap-1.5 text-xs">
                <i className="w-2 h-2 rounded-sm inline-block" style={{ background: SEV_COLOR[s] }} />
                <span className="text-muted capitalize">{s}</span>
                <b>{counts[s] || 0}</b>
              </div>
            ))}
          </div>
          {hourly.length === 0 ? (
            <Empty>events lack timestamps</Empty>
          ) : (
            /* The bar is a count of flagged lookups in that hour of the
               day, so the unit IS "events" — the same word the panel's own
               right-hand count uses. Recharts' default said `value : 0`. */
            <Suspense fallback={<Skeleton h={180} />}>
              <CategoryBars
                data={hourly}
                unit="events"
                height={180}
                xKey="hour"
                fill={COLORS.accent}
                tickSize={10}
                minTickGap={30}
              />
            </Suspense>
          )}
          {/* The severity legend above and the bars are both counted from
              `events`, which is one capped page — so on a busy window they
              describe the sample, not the window. The heading names the sample;
              this names its scope, once, rather than four times in the legend. */}
          {scopeNote && <div className="text-[11px] text-dim mt-2">{scopeNote}</div>}
        </>
      )}
    </Card>
  )
}

// ---------- kpi stack ----------

function KpiStack({ panelId, hub, events, acks }) {
  const { COLORS } = useChartTheme()
  const d = hub.data ?? {}
  const unackedCrit = events.filter((e) => !acks[ackKey(e)] && String(e.severity).toLowerCase() === 'critical').length

  // The fourth tile was `{ label: 'Total Events', value: d.total ?? events.length }`
  // and `d.total` was the server's row count, so on a capped window it printed
  // the page size under the word "Total". Measured live on 2026-08-20: the cap
  // was being hit and this tile read "Total Events 50" for an hour whose real
  // count had never been asked for.
  //
  // The `?? events.length` fallback is gone with it. That is the shape that let
  // the bug survive a rename: a consumer that substitutes the rows in hand for a
  // missing total is printing the sample under the total's label again.
  const totalCell = totalEventsTile(d, 'Total Events', 'Events Shown')
  const scopeNote = sampleScopeNote(d, 'events')

  const cells = [
    { label: 'Unacked Critical', value: unackedCrit, color: COLORS.crit },
    { label: 'Blocked', value: d.blocked ?? 0, color: COLORS.accent },
    { label: 'Logged', value: d.logged ?? 0, color: COLORS.other },
    { label: totalCell.label, value: totalCell.value, color: COLORS.purple },
  ]

  return (
    <Card panelId={panelId} span={2} title="Response Summary">
      {hub.loading ? <Skeleton h={200} /> : hub.data?.availability === 'error' || hub.error ? (
        <FeedUnavailable reason={hub.data?.reason} label="Threat feed unavailable" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {cells.map((c) => (
              <div key={c.label}>
                <div className="text-muted text-[11px]">{c.label}</div>
                <div className="text-xl font-semibold tracking-tight my-1" style={{ color: c.color }}>{Number(c.value).toLocaleString()}</div>
              </div>
            ))}
          </div>
          {/* Unacked Critical, Blocked and Logged stay sample-derived even when
              the tile beside them carries an authoritative total, so the note
              is not conditional on that: it says which numbers were counted
              from what, and a panel mixing scopes without saying so is the
              defect wearing a smaller hat. */}
          {scopeNote && <div className="text-[11px] text-dim mt-3">{scopeNote}</div>}
        </>
      )}
    </Card>
  )
}

// ---------- block action ----------

function BlockCell({ domain }) {
  const { COLORS } = useChartTheme()
  // idle | busy | verified | rejected | unverified | tokenRequired.
  // "verified" is the ONLY state that may show a green tick — it means a
  // read-back of the block list actually confirmed the desired state, not
  // just that the HTTP call returned ok. See dashboard/security.go's
  // outcome contract: verified / rejected / unverified.
  const [state, setState] = useState('idle')
  const [msg, setMsg] = useState('')
  const lastActionRef = useRef('block')
  const aliveRef = useRef(true)
  useEffect(() => {
    return () => { aliveRef.current = false }
  }, [])

  async function run(action) {
    if (!domain) return
    lastActionRef.current = action
    setState('busy')
    const res = await authFetch(`/api/${action}-domain`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    })
    if (!aliveRef.current) return
    if (res.tokenRequired) {
      setState('tokenRequired')
      return
    }
    const body = res.data || {}
    if (body.outcome === 'verified') {
      // A read-back proved the list's actual state — safe to show success.
      setState(action === 'block' ? 'verified' : 'idle')
      setMsg('')
      return
    }
    if (body.outcome === 'unverified') {
      // Write was submitted but read-back didn't converge in budget — the
      // mutation MAY have landed. Never imply success or failure here.
      setState('unverified')
      setMsg(body.error || 'change may have already applied — refresh and re-check before retrying')
      return
    }
    // "rejected" (upstream refused, or a local guard like missing
    // BLOCK_LIST_ID) — nothing was applied, safe to retry.
    setState('rejected')
    setMsg(body.error || `HTTP ${res.status}`)
  }

  if (!domain) return <span className="text-dim text-[11px]">—</span>
  if (state === 'busy') return <span className="text-[11px] text-muted">…</span>
  if (state === 'verified') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px]" style={{ color: COLORS.ok }}>blocked ✓</span>
        <button onClick={() => run('unblock')} className="px-1.5 py-0.5 rounded text-[10.5px] border border-border text-muted">Unblock</button>
      </div>
    )
  }
  if (state === 'tokenRequired') return <span className="text-[11px]" style={{ color: COLORS.warn }}>token required — set in ⚙ Settings</span>
  if (state === 'unverified') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px]" style={{ color: COLORS.warn }} title={msg}>
          unconfirmed — {msg}
        </span>
        <button onClick={() => run(lastActionRef.current)} className="px-1.5 py-0.5 rounded text-[10.5px] border border-border text-muted">Re-check</button>
      </div>
    )
  }
  if (state === 'rejected') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px]" style={{ color: COLORS.crit }} title={msg}>{msg}</span>
        <button onClick={() => run(lastActionRef.current)} className="px-1.5 py-0.5 rounded text-[10.5px] border border-border text-muted">Retry</button>
      </div>
    )
  }
  return (
    <button onClick={() => run('block')} className="px-1.5 py-0.5 rounded text-[10.5px] border border-border text-muted hover:text-field-txt">Block</button>
  )
}

// ---------- triage inbox ----------

function TriageInbox({ panelId, hub, events, acks, setAcks }) {
  const { COLORS } = useChartTheme()
  const SEV_COLOR = sevColorMap(COLORS)
  const [sevFilter, setSevFilter] = useState('all')
  const scopeNote = sampleScopeNote(hub.data, 'events')

  function toggleAck(e) {
    const k = ackKey(e)
    setAcks((prev) => ({ ...prev, [k]: !prev[k] }))
  }

  // hub.error covers the transport path (any non-2xx, or the 12s abort in
  // lib/api.js) — availability:"error" alone only covers the upstream-
  // reported failure, missing the case where the fetch itself never completed.
  const unavailable = hub.data?.availability === 'error' || !!hub.error

  const filtered = useMemo(() => {
    if (sevFilter === 'all') return events
    return events.filter((e) => String(e.severity).toLowerCase() === sevFilter)
  }, [events, sevFilter])

  // Default order matches the old severity-asc sort (Critical first); DataTable
  // re-sorts in place when a header is clicked.
  const rows = useMemo(
    () => [...filtered].sort((a, b) => sevRank(a.severity) - sevRank(b.severity)),
    [filtered],
  )

  const columns = [
    {
      key: 'ack',
      label: 'Ack',
      keep: true,
      render: (_v, r) => (
        <input type="checkbox" checked={!!acks[ackKey(r)]} onChange={() => toggleAck(r)} />
      ),
    },
    {
      key: 'block',
      label: 'Block',
      keep: true,
      render: (_v, r) => <BlockCell domain={r.qname} />,
    },
    {
      key: 'severity',
      label: 'Severity',
      keep: true,
      sortable: true,
      comparator: (a, b) => sevRank(a.severity) - sevRank(b.severity),
      render: (_v, r) => {
        const sev = String(r.severity || '').toLowerCase()
        return (
          <span className="font-medium uppercase text-[11px]" style={{ color: SEV_COLOR[sev] || COLORS.other }}>
            {r.severity || '—'}
          </span>
        )
      },
    },
    { key: 'qname', label: 'Query', mono: true, grow: true, sortable: true },
    { key: 'policy_action', label: 'Action', sortable: true },
    {
      key: 'event_time',
      label: 'Time',
      keep: true,
      sortable: true,
      render: (_v, r) => (
        <span
          className="block font-mono overflow-hidden whitespace-nowrap text-ellipsis text-dim text-[11px]"
          style={{ maxWidth: 180 }}
          title={r.event_time || undefined}
        >
          {r.event_time ? new Date(r.event_time).toLocaleString() : '—'}
        </span>
      ),
    },
  ]

  return (
    <Card
      panelId={panelId}
      span={6}
      title="Triage Inbox"
      right={
        <div className="flex items-center gap-1.5">
          {['all', ...SEV_ORDER].map((s) => (
            <button
              key={s}
              onClick={() => setSevFilter(s)}
              className="px-2 py-1 rounded-md text-[11px] capitalize border"
              style={{
                borderColor: sevFilter === s ? (SEV_COLOR[s] || COLORS.accent) : 'var(--color-border)',
                color: sevFilter === s ? (SEV_COLOR[s] || COLORS.accent) : 'var(--color-muted)',
              }}
            >
              {s}
            </button>
          ))}
          {!unavailable && <span className="text-[11px] text-muted ml-1">{rows.length.toLocaleString()}</span>}
        </div>
      }
    >
      {hub.loading ? <Skeleton h={260} /> : unavailable ? (
        <FeedUnavailable reason={hub.data?.reason} label="Threat feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no events match</Empty>
      ) : (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            maxHeight={420}
            rowCap={150}
            rowKey={(r, i) => ackKey(r) + i}
            rowStyle={(r) => ({ opacity: acks[ackKey(r)] ? 0.45 : 1 })}
          />
          {/* The figure beside the severity buttons counts the rows matching the
              filter, and those rows come from the same capped page as every
              other number on this tab. Without this line an inbox holding the
              first 50 of a bad hour reads as an inbox with 50 things in it. */}
          {scopeNote && <div className="text-[11px] text-dim mt-2">{scopeNote}</div>}
        </>
      )}
    </Card>
  )
}

// ---------- lookalike domains ----------

function LookalikeTable({ panelId, lookalikes }) {
  const { COLORS } = useChartTheme()
  const d = lookalikes.data ?? {}
  const rows = Array.isArray(d.domains) ? d.domains : []

  const columns = [
    { key: 'lookalike', label: 'Lookalike', mono: true, grow: true, sortable: true },
    { key: 'target', label: 'Target', sortable: true },
    {
      key: 'suspicious',
      label: 'Suspicious',
      keep: true,
      sortable: true,
      render: (_v, r) => (
        <span style={{ color: r.suspicious ? COLORS.crit : COLORS.other }}>{r.suspicious ? 'yes' : 'no'}</span>
      ),
    },
  ]

  // "0 detected" is a measurement. When the fetch failed, or upstream declared
  // itself unavailable, nothing was measured — the count is unknown, not zero.
  const counted = !lookalikes.error && !d.unavailable

  return (
    <Card panelId={panelId} span={3} title="Lookalike Domains" right={<span className="text-[11px] text-muted">{counted ? rows.length : '—'} detected</span>}>
      {lookalikes.loading ? <Skeleton h={220} /> : lookalikes.error ? (
        // Previously byte-identical to a genuinely empty result ("no data") —
        // a dead feed read as a clean estate.
        <FeedUnavailable reason={lookalikes.error.message || undefined} label="Lookalike domain feed unavailable" />
      ) : d.unavailable || rows.length === 0 ? (
        <Empty>{d.unavailable ? (d.not_entitled ? `not entitled — ${d.unavailable}` : d.unavailable) : 'no data'}</Empty>
      ) : (
        <DataTable rows={rows} columns={columns} maxHeight={320} rowCap={150} />
      )}
    </Card>
  )
}

// ---------- Axur supplier risk ----------

// Axur is the supply-chain and brand-protection vendor the Infoblox portal
// links out to. This panel is the whole integration on the read side: security
// indicators for each supplier the account monitors, worst first.
//
// WHAT IT USED TO SHOW, AND WHY THAT WAS WRONG. It first counted brand-abuse
// incidents — fake sites, lookalike domains — and reported a correct, permanent
// zero, because this account monitors ten SUPPLIERS and owns no brand assets
// beyond demo placeholders. A panel that can only say zero is worse than no
// panel: zero reads as "all clear" rather than as "nothing is being watched".
//
// It carries the same discipline as its neighbours — a failed feed never
// renders as a clean zero — plus two states they do not have. Axur is optional,
// so "no credential configured" exists and is NOT a fault; and its supplier
// endpoints need an account code, so "we could not work out which account" is a
// third thing, distinct from both an outage and a missing key.
//
// WHY IT DOES NOT VANISH WHEN UNCONFIGURED, having briefly done so. The first
// version dropped the panel from the grid on configured:false. That can only be
// decided AFTER the first /api/axur answers, so a fetch that fails — the browser
// aborting it on navigation is enough — left the panel wedged in an error state
// the 5-minute poll would not revisit; tests/layout-drag.spec.ts caught it as a
// Security tab with 14 panels instead of 13. Standing chrome, like every other
// panel here: a reader who does not want it takes it off with the ✕.
function AxurPanel({ panelId, axur }) {
  const { COLORS } = useChartTheme()
  const d = axur.data ?? {}
  const rows = Array.isArray(d.vendors) ? d.vendors : []

  const columns = [
    { key: 'name', label: 'Supplier', grow: true, sortable: true },
    {
      key: 'top_type',
      label: 'Worst indicator',
      sortable: true,
      // A supplier with nothing found has no worst anything. An em dash says
      // that; an empty cell would read as missing data.
      render: (v, r) => (r.findings > 0 ? <span className="font-mono text-[11px]">{v}</span> : <span className="text-dim">—</span>),
    },
    {
      key: 'findings',
      label: 'Findings',
      keep: true,
      sortable: true,
      render: (v) => <span style={{ color: v > 0 ? COLORS.warn : COLORS.other }}>{v}</span>,
    },
  ]

  // Same rule as LookalikeTable: a total is a measurement, and nothing was
  // measured when the fetch failed or upstream declared itself unavailable.
  const counted = !axur.error && !d.unavailable && d.configured !== false

  return (
    <Card
      panelId={panelId}
      span={3}
      title="Axur Supplier Risk"
      right={
        <span className="text-[11px] text-muted">
          {counted ? `${d.total_findings ?? 0} across ${rows.length}` : '—'}
        </span>
      }
    >
      {axur.loading ? <Skeleton h={220} /> : axur.error ? (
        <FeedUnavailable reason={axur.error.message || undefined} label="Axur feed unavailable" />
      ) : d.configured === false ? (
        // Names both places a key can go, Settings first: that is a box on this
        // screen, where AXUR_API_KEY needs a file edit and a restart.
        <Empty>Axur not configured — add a key under ⋯ Settings, or set AXUR_API_KEY</Empty>
      ) : d.unavailable ? (
        <Empty>{d.not_entitled ? `not entitled — ${d.unavailable}` : d.unavailable}</Empty>
      ) : rows.length === 0 ? (
        // NOT "no findings". Zero suppliers monitored and zero findings across
        // monitored suppliers are opposite pieces of news, and this panel exists
        // because the difference was invisible once already.
        <Empty>no suppliers monitored in Axur</Empty>
      ) : (
        <DataTable rows={rows} columns={columns} maxHeight={320} rowCap={150} />
      )}
    </Card>
  )
}

// ---------- CTEM exposure ----------

function CtemPanel({ panelId, ctem }) {
  const { COLORS } = useChartTheme()
  const SEV_COLOR = sevColorMap(COLORS)
  const d = ctem.data?.data ?? null
  const matrix = Array.isArray(d?.matrix) ? d.matrix : []
  const empty = !d || (!d.total_exposures && matrix.length === 0)
  // CSPCtemExposure returns status:"error" at HTTP 200 on an upstream failure —
  // the fetch itself never errors, so `ctem.error` alone never catches this.
  const status = ctem.data?.status

  const columns = [
    {
      key: 'severity',
      label: 'Severity',
      keep: true,
      sortable: true,
      comparator: (a, b) => sevRank(a.severity) - sevRank(b.severity),
      render: (_v, r) => {
        const sev = String(r.severity || '').toLowerCase()
        return (
          <span className="font-medium uppercase text-[11px]" style={{ color: SEV_COLOR[sev] || COLORS.other }}>
            {r.severity || '—'}
          </span>
        )
      },
    },
    { key: 'priority', label: 'Priority', sortable: true },
    { key: 'count', label: 'Count', align: 'right', mono: true, sortable: true },
  ]

  return (
    <Card panelId={panelId} span={3} title="CTEM Exposure" right={d?.total_exposures ? <span className="text-[11px] text-muted">{d.total_exposures.toLocaleString()} total</span> : null}>
      {ctem.loading ? <Skeleton h={220} /> : ctem.error || status === 'error' ? (
        <FeedUnavailable label="CTEM exposure feed unavailable" />
      ) : empty ? <Empty /> : (
        <DataTable rows={matrix} columns={columns} maxHeight={320} rowCap={150} />
      )}
    </Card>
  )
}

// ---------- threat feed activity ----------

// One row per day, not one per (day, action).
//
// /api/csp/threats returns the upstream cube verbatim: a row for every
// (day, action) pair, so seven days arrive as fourteen rows —
//   {"action":"Allow","day":"2026-07-31T00:00:00.000","requests":21420}
//   {"action":"Block","day":"2026-07-31T00:00:00.000","requests":438914}
// — and not even in a stable order (Jul 31 arrives Allow-first, Aug 1
// Block-first). Handing that straight to recharts drew fourteen bars under
// seven repeated date labels, in whatever order the feed felt like, which is
// why the axis had to fall back to raw ISO strings to keep them apart.
//
// Folding to {day, blocked, allowed} gives the chart the shape it was always
// describing: one column per day, split by outcome. The right fix is arguably
// upstream — go/internal/dashboard/csp.go:630 asks Cube for the `action`
// dimension and passes the result through untouched — but the pivot is four
// lines here and a schema change there, so it lives here for now.
//
// Day order is first-appearance, not sorted: the feed returns oldest-first and
// re-sorting ISO strings would silently reorder any feed that doesn't.
function pivotByDay(rows) {
  const byDay = new Map()
  for (const r of rows) {
    const day = r.day ?? ''
    if (!byDay.has(day)) byDay.set(day, { day, blocked: 0, allowed: 0 })
    const bucket = byDay.get(day)
    const n = Number(r.requests) || 0
    const action = String(r.action || '').toLowerCase()
    if (action === 'block') bucket.blocked += n
    else if (action === 'allow') bucket.allowed += n
  }
  return [...byDay.values()]
}

function ThreatFeed({ panelId, threats }) {
  const { COLORS } = useChartTheme()
  const rows = threats.data?.rows ?? NO_ROWS
  const status = threats.data?.status
  const chartData = useMemo(() => pivotByDay(rows), [rows])
  const totals = chartData.reduce(
    (m, d) => ({ block: m.block + d.blocked, allow: m.allow + d.allowed }),
    { block: 0, allow: 0 },
  )

  return (
    <Card panelId={panelId} span={3} title="Threat Feed Activity">
      {threats.loading ? <Skeleton h={220} /> : threats.error || status === 'error' ? (
        <FeedUnavailable label="Threat feed activity unavailable" />
      ) : rows.length === 0 ? <Empty /> : (
        <>
          <div className="flex gap-5 mb-2">
            <div><span className="text-xl font-semibold" style={{ color: COLORS.crit }}>{totals.block.toLocaleString()}</span><div className="text-[11px] text-muted">Blocked</div></div>
            <div><span className="text-xl font-semibold">{totals.allow.toLocaleString()}</span><div className="text-[11px] text-muted">Allowed</div></div>
          </div>
          <Suspense fallback={<Skeleton h={150} />}>
            <StackedDayBars
              data={chartData}
              blockedColor={COLORS.crit}
              allowedColor={COLORS.accent}
              tickFormat={fmtShortDay}
              height={150}
            />
          </Suspense>
        </>
      )}
    </Card>
  )
}

// ---------- SOC insights ----------

function InsightsPanel({ panelId, insights }) {
  const d = insights.data
  // FetchInsights returns {"data":[],"unavailable":"…","availability":"error"}
  // on a dead upstream — reading only d.data (or d directly) can't distinguish
  // that from a genuine empty result, both render as "no data".
  const unavailable = !!insights.error || (d && !Array.isArray(d) && d.availability === 'error')
  const rows = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : Array.isArray(d?.data) ? d.data : NO_ROWS

  // Columns are named explicitly. They used to be Object.keys(rows[0]).slice(0, 4)
  // — an alphabetical slice of whatever the payload happened to contain, which
  // is how a constant `count: 1` field became the operator's headline column
  // and pushed the threat name off the table. What is worth showing is a
  // decision, not an accident of key order.
  const normRows = useMemo(
    () =>
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        severity: r.severity,
        currentStatus: r.currentStatus,
        totalEvents: r.totalEvents,
        // null when upstream did not report it — DataTable renders that as an
        // em-dash and auto-hides the column when no row reports it.
        totalVerifiedAssets: r.totalVerifiedAssets,
        feedSource: r.feedSource,
        lastSeen: r.mostRecentAt ? fmtDate(r.mostRecentAt) : '—',
        lastSeenAt: r.mostRecentAt ?? '',
      })),
    [rows],
  )

  // hideWhenConstant (DataTable): drop a column whose non-empty values are all
  // identical — one feed source across every row, or an assets count upstream
  // does not vary — because a column that says the same thing on every row
  // costs width and tells the operator nothing. DataTable already drops a
  // column that is empty ('—') on every row, which is what an unreported
  // totalVerifiedAssets now is: null on the wire, never a fabricated 0.
  const columns = [
    { key: 'name', label: 'Threat', grow: true, sortable: true },
    { key: 'severity', label: 'Severity', sortable: true, sortAccessor: (r) => sevRank(r.severity) },
    { key: 'currentStatus', label: 'Status', sortable: true },
    { key: 'totalEvents', label: 'Events', align: 'right', mono: true, sortable: true },
    { key: 'totalVerifiedAssets', label: 'Assets', align: 'right', mono: true, sortable: true, hideWhenConstant: true },
    { key: 'feedSource', label: 'Feed', sortable: true, hideWhenConstant: true },
    { key: 'lastSeen', label: 'Last Seen', sortable: true, sortAccessor: (r) => r.lastSeenAt },
  ]

  return (
    <Card panelId={panelId} span={3} title="SOC Insights" right={!unavailable && rows.length ? <span className="text-[11px] text-muted">{rows.length.toLocaleString()}</span> : null}>
      {insights.loading ? <Skeleton h={220} /> : unavailable ? (
        <FeedUnavailable reason={typeof d?.unavailable === 'string' ? d.unavailable : undefined} label="SOC insights unavailable" />
      ) : rows.length === 0 ? <Empty /> : (
        <DataTable rows={normRows} columns={columns} maxHeight={320} rowCap={150} />
      )}
    </Card>
  )
}

// ---------- asset insights (severity buckets) ----------

function AssetInsights({ panelId, assetInsights }) {
  const d = assetInsights.data ?? {}
  const status = d.status
  const hasTotal = typeof d.total === 'number' && d.total > 0

  return (
    <Card panelId={panelId} span={3} title="Asset Insights">
      {assetInsights.loading ? <Skeleton h={220} /> : assetInsights.error || status === 'error' ? (
        <FeedUnavailable label="Asset insights unavailable" />
      ) : status === 'empty' || !hasTotal ? (
        <Empty>no asset insights for this tenant</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          <div>
            <div className="text-[11px] text-muted">Total Findings</div>
            <div className="text-xl font-semibold tracking-tight my-1">{d.total.toLocaleString()}</div>
          </div>
          {d.breakdown_available === false ? (
            <div className="text-[11px] text-dim">{d.note || 'severity breakdown unavailable upstream'}</div>
          ) : null}
        </div>
      )}
    </Card>
  )
}

// ---------- exposures ----------

function fmtDate(v) {
  if (!v) return '—'
  const ms = new Date(v).getTime()
  return isNaN(ms) ? '—' : new Date(ms).toLocaleDateString()
}

function ExposuresPanel({ panelId, exposures }) {
  const payload = exposures.data ?? {}
  const availability = payload.availability
  const rows = payload.data?.rows ?? NO_ROWS
  const count = payload.data?.count ?? rows.length
  const total = payload.data?.total_available

  const columns = [
    { key: 'title', label: 'Title', grow: true, sortable: true },
    { key: 'status', label: 'Status', sortable: true },
    { key: 'first_seen_at', label: 'First Seen', sortable: true, render: (v) => fmtDate(v) },
    { key: 'last_seen_at', label: 'Last Seen', sortable: true, render: (v) => fmtDate(v) },
  ]

  const rightNode =
    availability === 'ok' && typeof total === 'number'
      ? <span className="text-[11px] text-muted">{total.toLocaleString()} total</span>
      : availability === 'metadata-degraded'
        ? <span className="text-[11px] text-muted">{count.toLocaleString()} rows loaded</span>
        : count ? <span className="text-[11px] text-muted">{count.toLocaleString()}</span> : null

  return (
    <Card panelId={panelId} span={4} title="Exposures" right={rightNode}>
      {exposures.loading ? <Skeleton h={260} /> : availability === 'error' ? (
        <FeedUnavailable reason={payload.reason} label="Exposures feed unavailable" />
      ) : exposures.error ? (
        // A transport failure/500/abort used to fall into "no exposures
        // reported" — an all-clear attack surface produced by a dead fetch.
        <FeedUnavailable reason={exposures.error.message || undefined} label="Exposures feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no exposures reported</Empty>
      ) : (
        <>
          <div className="text-[11px] text-muted mb-1">
            {availability === 'metadata-degraded'
              ? `Total unavailable, ${count.toLocaleString()} rows loaded`
              : typeof total === 'number'
                ? `${count.toLocaleString()} of ${total.toLocaleString()}, upstream order — not ranked by severity`
                : `${count.toLocaleString()} rows, upstream order`}
          </div>
          <DataTable rows={rows} columns={columns} maxHeight={360} rowCap={150} rowKey={(r) => r.id} />
        </>
      )}
    </Card>
  )
}

// ---------- asset risk ----------

function AssetRiskPanel({ panelId, assetRisk }) {
  const raw = assetRisk.data?.data?.rows ?? NO_ROWS
  const count = assetRisk.data?.data?.count ?? raw.length
  // CSPAssetRisk returns status:"error" at HTTP 200 on an upstream failure —
  // the fetch itself never errors, so `assetRisk.error` alone never catches this.
  const status = assetRisk.data?.status
  const rows = useMemo(
    () => [...raw].sort((a, b) => (Number(b.exposures) || 0) - (Number(a.exposures) || 0)),
    [raw],
  )

  const columns = [
    { key: 'domain_name', label: 'Domain', mono: true, grow: true, sortable: true },
    { key: 'ip_address', label: 'IP', mono: true, sortable: true },
    { key: 'asset_type', label: 'Type', sortable: true },
    { key: 'exposures', label: 'Exposures', align: 'right', mono: true, sortable: true },
    { key: 'ports_count', label: 'Ports', align: 'right', mono: true, sortable: true },
    { key: 'status', label: 'Status', sortable: true },
  ]

  return (
    <Card panelId={panelId} span={4} title="Asset Risk" right={count ? <span className="text-[11px] text-muted">{count.toLocaleString()}</span> : null}>
      {assetRisk.loading ? <Skeleton h={260} /> : assetRisk.error || status === 'error' ? (
        <FeedUnavailable label="Asset risk feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no asset risk data</Empty>
      ) : (
        <DataTable rows={rows} columns={columns} maxHeight={360} rowCap={150} rowKey={(r, i) => `${r.domain_name}|${r.ip_address}|${i}`} />
      )}
    </Card>
  )
}

// ---------- exposed hostnames / ips (huge single-column lists) ----------

function ExposedSurfacePanel({ panelId, hostnames, ips }) {
  const hPayload = hostnames.data ?? {}
  const iPayload = ips.data ?? {}
  const hAvail = hPayload.availability
  const iAvail = iPayload.availability
  const hRows = hPayload.data?.rows ?? []
  const hCount = hPayload.data?.count ?? hRows.length
  const iRows = iPayload.data?.rows ?? []
  const iCount = iPayload.data?.count ?? iRows.length

  const loading = hostnames.loading || ips.loading
  const hDead = hAvail === 'error'
  const iDead = iAvail === 'error'
  const bothDead = hDead && iDead

  const SAMPLE = 25
  const hCols = [{ key: 'hostname', label: 'Hostname', mono: true, grow: true }]
  const iCols = [{ key: 'ip', label: 'IP', mono: true }]

  // metadata-degraded feeds have rows but no verified total — never call it a total.
  function countLabel(count, avail) {
    return avail === 'metadata-degraded' ? `${count.toLocaleString()} rows loaded` : count.toLocaleString()
  }

  return (
    <Card
      panelId={panelId}
      span={4}
      title="Exposed Surface"
      right={
        loading || bothDead ? null : (
          <span className="text-[11px] text-muted">
            {hDead ? 'hostnames unavailable' : `${countLabel(hCount, hAvail)} hostnames`}
            {' · '}
            {iDead ? 'IPs unavailable' : `${countLabel(iCount, iAvail)} IPs`}
          </span>
        )
      }
    >
      {loading ? <Skeleton h={260} /> : bothDead ? (
        <FeedUnavailable reason={hPayload.reason || iPayload.reason} label="Exposed surface feeds unavailable" />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[11px] text-muted mb-1">
              {hDead ? 'Hostnames' : `Showing ${Math.min(SAMPLE, hRows.length).toLocaleString()} of ${countLabel(hCount, hAvail)}`}
            </div>
            {hDead ? (
              <FeedUnavailable reason={hPayload.reason} label="Hostname feed unavailable" />
            ) : hRows.length === 0 ? (
              <Empty>no hostnames reported</Empty>
            ) : (
              <DataTable rows={hRows} columns={hCols} maxHeight={280} rowCap={SAMPLE} rowKey={(r, i) => `${r.hostname}|${i}`} />
            )}
          </div>
          <div>
            <div className="text-[11px] text-muted mb-1">
              {iDead ? 'IPs' : `Showing ${Math.min(SAMPLE, iRows.length).toLocaleString()} of ${countLabel(iCount, iAvail)}`}
            </div>
            {iDead ? (
              <FeedUnavailable reason={iPayload.reason} label="IP feed unavailable" />
            ) : iRows.length === 0 ? (
              <Empty>no IPs reported</Empty>
            ) : (
              <DataTable rows={iRows} columns={iCols} maxHeight={280} rowCap={SAMPLE} rowKey={(r, i) => `${r.ip}|${i}`} />
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

// ---------- CTEM assets (aggregate) ----------

function summarizeArr(arr, n = 6) {
  if (!Array.isArray(arr) || arr.length === 0) return { count: 0, sample: [] }
  const sample = arr.slice(0, n).map((v) => {
    if (v == null) return '—'
    if (typeof v === 'object') return v.name ?? v.label ?? v.value ?? JSON.stringify(v)
    return String(v)
  })
  return { count: arr.length, sample }
}

function CtemAssetsPanel({ panelId, ctemAssets }) {
  const d = ctemAssets.data?.data ?? null
  const assetCount = d?.asset_count
  // CSPCtemAssets returns status:"error" at HTTP 200 on an upstream failure —
  // the fetch itself never errors, so `ctemAssets.error` alone never catches this.
  const status = ctemAssets.data?.status

  const groups = useMemo(() => {
    if (!d) return []
    const out = []
    for (const [key, val] of Object.entries(d)) {
      if (key === 'asset_count') continue
      if (Array.isArray(val)) out.push({ key, ...summarizeArr(val) })
    }
    return out
  }, [d])

  const empty = !d || (!assetCount && groups.every((g) => g.count === 0))

  return (
    <Card
      panelId={panelId}
      span={4}
      title="CTEM Assets"
      right={assetCount ? <span className="text-[11px] text-muted">{assetCount.toLocaleString()} assets</span> : null}
    >
      {ctemAssets.loading ? <Skeleton h={260} /> : ctemAssets.error || status === 'error' ? (
        <FeedUnavailable label="CTEM assets feed unavailable" />
      ) : empty ? (
        <Empty>no CTEM asset data</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="text-xs text-muted capitalize mb-1">
                {g.key.replace(/_/g, ' ')} <b className="text-field-txt">{g.count.toLocaleString()}</b> distinct
              </div>
              <div className="flex flex-wrap gap-1">
                {g.sample.map((s, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded text-[10.5px] border border-border text-muted">{s}</span>
                ))}
                {g.count > g.sample.length ? (
                  <span className="px-1.5 py-0.5 text-[10.5px] text-dim">+{(g.count - g.sample.length).toLocaleString()} more</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------- security inventory (hub/domains) ----------

// WHAT THIS IS AND IS NOT. It is a count of what is CONFIGURED — policies,
// feeds, lists, roaming endpoints, anycast members. It is deliberately not
// called "coverage": a count of named lists says nothing about whether anything
// is protected, and a panel whose title claims more than its numbers support is
// the failure mode this repo keeps fixing.
//
// TWO SECTIONS OF /api/hub/domains ARE LEFT OUT ON PURPOSE. dfp_services is
// already the "DFP Services" panel on Infra and host_inventory is already
// Infra's "Host Inventory"; drawing either here would put the same number on
// two tabs under two names, and the first time they disagreed nobody would know
// which was right.
//
// Every section carries its own availability, so one dead feed shows as
// unavailable in its own row while the rest stay real — the payload is built
// that way precisely so a single failure cannot blank the panel or, worse,
// render as a row of zeros.
const INVENTORY_SECTIONS = [
  { key: 'security_policies', label: 'Security policies' },
  { key: 'threat_feeds', label: 'Threat feeds' },
  { key: 'named_lists', label: 'Named lists' },
  { key: 'roaming_endpoints', label: 'Roaming endpoints' },
  { key: 'anycast_ha', label: 'Anycast HA members' },
]

function SecurityInventory({ panelId, hub }) {
  const body = hub.data ?? null
  // Whole-request failure. Per-section failures are handled per row, which is
  // the point of the availability map.
  const dead = !hub.loading && (!!hub.error || body === null)

  return (
    <Card panelId={panelId} span={2} title="Security Inventory" note="what is configured">
      {hub.loading ? (
        <Skeleton h={200} />
      ) : dead ? (
        <FeedUnavailable label="Security inventory unavailable" />
      ) : (
        <div className="flex flex-col gap-2 mt-1">
          {INVENTORY_SECTIONS.map((s) => {
            const { value, note } = inventoryRow(s.key, body)
            return (
              <div key={s.key} className="flex items-center justify-between gap-2 py-1">
                <span className="text-[13px] text-muted">{s.label}</span>
                <div className="flex items-center gap-2">
                  {note && <span className="text-[11px] text-dim">{note}</span>}
                  <span className="text-[15px] font-semibold tabular-nums text-txt w-10 text-right">
                    {value === null ? DASH : value.toLocaleString()}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
