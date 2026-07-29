import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { authFetch } from '../lib/authFetch.js'
import { useChartTheme, Card, CardGrid, Empty, Skeleton, FeedUnavailable } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useThemeColors } from '../lib/theme.jsx'

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

export default function Security() {
  const hub = useApi('/api/hub/security')
  const threats = useApi('/api/csp/threats', { poll: 30000 })
  const lookalikes = useApi('/api/lookalikes')
  const insights = useApi('/api/insights')
  const ctem = useApi('/api/csp/ctem-exposure', { poll: 30000 })
  const assetInsights = useApi('/api/csp/asset-insights', { poll: 30000 })
  const exposures = useApi('/api/csp/exposures', { poll: 30000 })
  const assetRisk = useApi('/api/csp/asset-risk', { poll: 30000 })
  const exposedHostnames = useApi('/api/csp/exposed-hostnames', { poll: 30000 })
  const exposedIps = useApi('/api/csp/exposed-ips', { poll: 30000 })
  const ctemAssets = useApi('/api/csp/ctem-assets', { poll: 30000 })
  const [acks, setAcks] = useState({})

  const events = hub.data?.events ?? []

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Security</h1>
      <CardGrid>
        <SeverityHero hub={hub} events={events} />
        <KpiStack hub={hub} events={events} acks={acks} />
        <TriageInbox hub={hub} events={events} acks={acks} setAcks={setAcks} />
        <LookalikeTable lookalikes={lookalikes} />
        <CtemPanel ctem={ctem} />
        <AssetInsights assetInsights={assetInsights} />
        <ExposuresPanel exposures={exposures} />
        <AssetRiskPanel assetRisk={assetRisk} />
        <ExposedSurfacePanel hostnames={exposedHostnames} ips={exposedIps} />
        <CtemAssetsPanel ctemAssets={ctemAssets} />
        <ThreatFeed threats={threats} />
        <InsightsPanel insights={insights} />
      </CardGrid>
    </div>
  )
}

// ---------- severity hero ----------

function SeverityHero({ hub, events }) {
  const { COLORS, TT } = useChartTheme()
  const { grid, tick } = useThemeColors()
  const SEV_COLOR = sevColorMap(COLORS)
  const counts = hub.data?.counts ?? {}
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

  return (
    <Card span={4} title="Threat Events — by Severity" right={<span className="text-[11px] text-muted">{events.length.toLocaleString()} events</span>}>
      {hub.loading ? (
        <Skeleton h={230} />
      ) : hub.data?.availability === 'unavailable' ? (
        <FeedUnavailable reason={hub.data?.reason} label="Threat feed unavailable" />
      ) : hub.error || events.length === 0 ? (
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
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={hourly} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="hour" tick={{ fill: tick, fontSize: 10 }} axisLine={{ stroke: grid }} tickLine={false} minTickGap={30} />
                <YAxis hide />
                <Tooltip {...TT} />
                <Bar dataKey="value" radius={[3, 3, 0, 0]} fill={COLORS.accent} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </>
      )}
    </Card>
  )
}

// ---------- kpi stack ----------

function KpiStack({ hub, events, acks }) {
  const { COLORS } = useChartTheme()
  const d = hub.data ?? {}
  const unackedCrit = events.filter((e) => !acks[ackKey(e)] && String(e.severity).toLowerCase() === 'critical').length

  const cells = [
    { label: 'Unacked Critical', value: unackedCrit, color: COLORS.crit },
    { label: 'Blocked', value: d.blocked ?? 0, color: COLORS.accent },
    { label: 'Logged', value: d.logged ?? 0, color: COLORS.other },
    { label: 'Total Events', value: d.total ?? events.length, color: COLORS.purple },
  ]

  return (
    <Card span={2} title="Response Summary">
      {hub.loading ? <Skeleton h={200} /> : hub.data?.availability === 'unavailable' ? (
        <FeedUnavailable reason={hub.data?.reason} label="Threat feed unavailable" />
      ) : hub.error ? <Empty /> : (
        <div className="grid grid-cols-2 gap-3">
          {cells.map((c) => (
            <div key={c.label}>
              <div className="text-muted text-[11px]">{c.label}</div>
              <div className="text-xl font-semibold tracking-tight my-1" style={{ color: c.color }}>{Number(c.value).toLocaleString()}</div>
            </div>
          ))}
        </div>
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

function TriageInbox({ hub, events, acks, setAcks }) {
  const { COLORS } = useChartTheme()
  const SEV_COLOR = sevColorMap(COLORS)
  const [sevFilter, setSevFilter] = useState('all')

  function toggleAck(e) {
    const k = ackKey(e)
    setAcks((prev) => ({ ...prev, [k]: !prev[k] }))
  }

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
          <span className="text-[11px] text-muted ml-1">{rows.length.toLocaleString()}</span>
        </div>
      }
    >
      {hub.loading ? <Skeleton h={260} /> : hub.data?.availability === 'unavailable' ? (
        <FeedUnavailable reason={hub.data?.reason} label="Threat feed unavailable" />
      ) : hub.error || rows.length === 0 ? (
        <Empty>{hub.error ? 'no data' : 'no events match'}</Empty>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          maxHeight={420}
          rowCap={150}
          rowKey={(r, i) => ackKey(r) + i}
          rowStyle={(r) => ({ opacity: acks[ackKey(r)] ? 0.45 : 1 })}
        />
      )}
    </Card>
  )
}

// ---------- lookalike domains ----------

function LookalikeTable({ lookalikes }) {
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

  return (
    <Card span={3} title="Lookalike Domains" right={<span className="text-[11px] text-muted">{rows.length} detected</span>}>
      {lookalikes.loading ? <Skeleton h={220} /> : lookalikes.error || d.unavailable || rows.length === 0 ? (
        <Empty>{d.unavailable ? (d.not_entitled ? `not entitled — ${d.unavailable}` : d.unavailable) : 'no data'}</Empty>
      ) : (
        <DataTable rows={rows} columns={columns} maxHeight={320} rowCap={150} />
      )}
    </Card>
  )
}

// ---------- CTEM exposure ----------

function CtemPanel({ ctem }) {
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
    <Card span={3} title="CTEM Exposure" right={d?.total_exposures ? <span className="text-[11px] text-muted">{d.total_exposures.toLocaleString()} total</span> : null}>
      {ctem.loading ? <Skeleton h={220} /> : ctem.error || status === 'error' ? (
        <FeedUnavailable label="CTEM exposure feed unavailable" />
      ) : empty ? <Empty /> : (
        <DataTable rows={matrix} columns={columns} maxHeight={320} rowCap={150} />
      )}
    </Card>
  )
}

// ---------- threat feed activity ----------

function ThreatFeed({ threats }) {
  const { COLORS, TT } = useChartTheme()
  const { grid, tick } = useThemeColors()
  const rows = threats.data?.rows ?? []
  const status = threats.data?.status
  const chartData = rows.map((r) => ({ day: r.day, requests: Number(r.requests) || 0, action: String(r.action || '').toLowerCase() }))
  const totals = rows.reduce((m, r) => {
    const a = String(r.action || '').toLowerCase()
    const n = Number(r.requests) || 0
    if (a === 'block') m.block += n
    else if (a === 'allow') m.allow += n
    return m
  }, { block: 0, allow: 0 })

  return (
    <Card span={3} title="Threat Feed Activity">
      {threats.loading ? <Skeleton h={220} /> : threats.error || status === 'error' || rows.length === 0 ? <Empty /> : (
        <>
          <div className="flex gap-5 mb-2">
            <div><span className="text-xl font-semibold" style={{ color: COLORS.crit }}>{totals.block.toLocaleString()}</span><div className="text-[11px] text-muted">Blocked</div></div>
            <div><span className="text-xl font-semibold">{totals.allow.toLocaleString()}</span><div className="text-[11px] text-muted">Allowed</div></div>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="day" tick={{ fill: tick, fontSize: 10 }} axisLine={{ stroke: grid }} tickLine={false} minTickGap={30} />
              <YAxis hide />
              <Tooltip {...TT} />
              <Bar dataKey="requests" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {chartData.map((r, i) => (
                  <Cell key={i} fill={r.action === 'block' ? COLORS.crit : COLORS.accent} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </Card>
  )
}

// ---------- SOC insights ----------

function InsightsPanel({ insights }) {
  const d = insights.data
  const rows = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : Array.isArray(d?.data) ? d.data : []
  const keys = rows.length ? Object.keys(rows[0]).slice(0, 4) : []

  // Flatten object cells to strings up front so the primitive renders text only.
  const normRows = useMemo(
    () =>
      rows.map((r) => {
        const o = {}
        for (const k of keys) o[k] = typeof r[k] === 'object' && r[k] !== null ? JSON.stringify(r[k]) : (r[k] ?? '—')
        return o
      }),
    [rows, keys.join('|')],
  )

  // First column is the ID/hash-like field — force one mono line + ellipsis (was
  // wrapping into a 4-line stack). The rest line-clamp as normal text.
  const columns = keys.map((k, i) => ({
    key: k,
    label: k.replace(/_/g, ' '),
    sortable: true,
    ...(i === 0 ? { mono: true, grow: true } : {}),
    ...(k === 'id' ? { maxCh: 14 } : {}), // measured: bare 36-char UUID overflows the card; cap it
  }))

  return (
    <Card span={3} title="SOC Insights" right={rows.length ? <span className="text-[11px] text-muted">{rows.length.toLocaleString()}</span> : null}>
      {insights.loading ? <Skeleton h={220} /> : insights.error || rows.length === 0 ? <Empty /> : (
        <DataTable rows={normRows} columns={columns} maxHeight={320} rowCap={150} />
      )}
    </Card>
  )
}

// ---------- asset insights (severity buckets) ----------

function AssetInsights({ assetInsights }) {
  const d = assetInsights.data ?? {}
  const status = d.status
  const hasTotal = typeof d.total === 'number' && d.total > 0

  return (
    <Card span={3} title="Asset Insights">
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

function ExposuresPanel({ exposures }) {
  const payload = exposures.data ?? {}
  const availability = payload.availability
  const rows = payload.data?.rows ?? []
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
    <Card span={4} title="Exposures" right={rightNode}>
      {exposures.loading ? <Skeleton h={260} /> : availability === 'unavailable' ? (
        <FeedUnavailable reason={payload.reason} label="Exposures feed unavailable" />
      ) : exposures.error || rows.length === 0 ? (
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

function AssetRiskPanel({ assetRisk }) {
  const raw = assetRisk.data?.data?.rows ?? []
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
    <Card span={4} title="Asset Risk" right={count ? <span className="text-[11px] text-muted">{count.toLocaleString()}</span> : null}>
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

function ExposedSurfacePanel({ hostnames, ips }) {
  const hPayload = hostnames.data ?? {}
  const iPayload = ips.data ?? {}
  const hAvail = hPayload.availability
  const iAvail = iPayload.availability
  const hRows = hPayload.data?.rows ?? []
  const hCount = hPayload.data?.count ?? hRows.length
  const iRows = iPayload.data?.rows ?? []
  const iCount = iPayload.data?.count ?? iRows.length

  const loading = hostnames.loading || ips.loading
  const hDead = hAvail === 'unavailable'
  const iDead = iAvail === 'unavailable'
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

function CtemAssetsPanel({ ctemAssets }) {
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
