import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { authFetch } from '../lib/authFetch.js'
import { useChartTheme, Card, Empty, Skeleton } from '../components/ui.jsx'
import { useThemeColors } from '../lib/theme.jsx'

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
  const [acks, setAcks] = useState({})

  const events = hub.data?.events ?? []

  return (
    <div className="max-w-[1340px] mx-auto p-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Security</h1>
      <div className="grid grid-cols-6 gap-3">
        <SeverityHero hub={hub} events={events} />
        <KpiStack hub={hub} events={events} acks={acks} />
        <TriageInbox hub={hub} events={events} acks={acks} setAcks={setAcks} />
        <LookalikeTable lookalikes={lookalikes} />
        <CtemPanel ctem={ctem} />
        <ThreatFeed threats={threats} />
        <InsightsPanel insights={insights} />
      </div>
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
      {hub.loading ? <Skeleton h={200} /> : hub.error ? <Empty /> : (
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
  const [state, setState] = useState('idle') // idle | busy | blocked | tokenRequired | error
  const [msg, setMsg] = useState('')
  const aliveRef = useRef(true)
  useEffect(() => {
    return () => { aliveRef.current = false }
  }, [])

  async function run(action) {
    if (!domain) return
    setState('busy')
    const res = await authFetch(`/api/${action}-domain`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    })
    if (!aliveRef.current) return
    if (res.ok) {
      setState(action === 'block' ? 'blocked' : 'idle')
    } else if (res.tokenRequired) {
      setState('tokenRequired')
    } else {
      setState('error')
      setMsg((res.data && res.data.error) || `HTTP ${res.status}`)
    }
  }

  if (!domain) return <span className="text-dim text-[11px]">—</span>
  if (state === 'busy') return <span className="text-[11px] text-muted">…</span>
  if (state === 'blocked') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px]" style={{ color: COLORS.ok }}>blocked ✓</span>
        <button onClick={() => run('unblock')} className="px-1.5 py-0.5 rounded text-[10.5px] border border-border text-muted">Unblock</button>
      </div>
    )
  }
  if (state === 'tokenRequired') return <span className="text-[11px]" style={{ color: COLORS.warn }}>token required — set in ⚙ Settings</span>
  if (state === 'error') return <span className="text-[11px]" style={{ color: COLORS.crit }}>{msg}</span>
  return (
    <button onClick={() => run('block')} className="px-1.5 py-0.5 rounded text-[10.5px] border border-border text-muted hover:text-field-txt">Block</button>
  )
}

// ---------- triage inbox ----------

function TriageInbox({ hub, events, acks, setAcks }) {
  const { COLORS } = useChartTheme()
  const SEV_COLOR = sevColorMap(COLORS)
  const [sevFilter, setSevFilter] = useState('all')
  const [sort, setSort] = useState({ key: 'severity', dir: 'asc' })

  function toggleAck(e) {
    const k = ackKey(e)
    setAcks((prev) => ({ ...prev, [k]: !prev[k] }))
  }

  const filtered = useMemo(() => {
    if (sevFilter === 'all') return events
    return events.filter((e) => String(e.severity).toLowerCase() === sevFilter)
  }, [events, sevFilter])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    const rank = (s) => SEV_ORDER.indexOf(String(s).toLowerCase())
    arr.sort((a, b) => {
      let av, bv
      if (key === 'severity') { av = rank(a.severity); bv = rank(b.severity) }
      else if (key === 'qname') { av = a.qname || ''; bv = b.qname || '' }
      else if (key === 'time') { av = a.event_time || ''; bv = b.event_time || '' }
      else { av = a.policy_action || ''; bv = b.policy_action || '' }
      if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return dir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [filtered, sort])

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const top = sorted.slice(0, 25)
  const headers = [
    { key: 'severity', label: 'Severity' },
    { key: 'qname', label: 'Query' },
    { key: 'action', label: 'Action' },
    { key: 'time', label: 'Time' },
  ]

  return (
    <Card
      span={6}
      title="Triage Inbox"
      right={
        <div className="flex gap-1.5">
          {['all', ...SEV_ORDER].map((s) => (
            <button
              key={s}
              onClick={() => setSevFilter(s)}
              className="px-2 py-1 rounded-md text-[11px] capitalize border"
              style={{
                borderColor: sevFilter === s ? (SEV_COLOR[s] || COLORS.accent) : 'var(--color-border)',
                color: sevFilter === s ? (SEV_COLOR[s] || COLORS.accent) : COLORS.other,
              }}
            >
              {s}
            </button>
          ))}
        </div>
      }
    >
      {hub.loading ? <Skeleton h={260} /> : hub.error || sorted.length === 0 ? (
        <Empty>{hub.error ? 'no data' : 'no events match'}</Empty>
      ) : (
        <table className="w-full border-collapse mt-2.5 text-sm">
          <thead>
            <tr>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Ack</th>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Block</th>
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
            {top.map((e, i) => {
              const sev = String(e.severity || '').toLowerCase()
              const acked = !!acks[ackKey(e)]
              return (
                <tr key={ackKey(e) + i} style={{ opacity: acked ? 0.45 : 1 }}>
                  <td className="py-2 px-2.5 border-b border-line">
                    <input type="checkbox" checked={acked} onChange={() => toggleAck(e)} />
                  </td>
                  <td className="py-2 px-2.5 border-b border-line">
                    <BlockCell domain={e.qname} />
                  </td>
                  <td className="py-2 px-2.5 border-b border-line font-medium uppercase text-[11px]" style={{ color: SEV_COLOR[sev] || COLORS.other }}>{e.severity || '—'}</td>
                  <td className="py-2 px-2.5 border-b border-line font-mono">{e.qname || '—'}</td>
                  <td className="py-2 px-2.5 border-b border-line text-muted">{e.policy_action || '—'}</td>
                  <td className="py-2 px-2.5 border-b border-line text-dim text-[11px]">{e.event_time ? new Date(e.event_time).toLocaleString() : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ---------- lookalike domains ----------

function LookalikeTable({ lookalikes }) {
  const { COLORS } = useChartTheme()
  const d = lookalikes.data ?? {}
  const rows = Array.isArray(d.domains) ? d.domains : []

  return (
    <Card span={3} title="Lookalike Domains" right={<span className="text-[11px] text-muted">{rows.length} detected</span>}>
      {lookalikes.loading ? <Skeleton h={220} /> : lookalikes.error || d.unavailable || rows.length === 0 ? (
        <Empty>{d.unavailable ? `not entitled — ${d.unavailable}` : 'no data'}</Empty>
      ) : (
        <table className="w-full border-collapse mt-2.5 text-sm">
          <thead>
            <tr>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Lookalike</th>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Target</th>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Suspicious</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 15).map((r, i) => (
              <tr key={(r.lookalike || i) + '' + i}>
                <td className="py-2 px-2.5 border-b border-line font-mono">{r.lookalike || '—'}</td>
                <td className="py-2 px-2.5 border-b border-line text-muted">{r.target || '—'}</td>
                <td className="py-2 px-2.5 border-b border-line" style={{ color: r.suspicious ? COLORS.crit : COLORS.other }}>{r.suspicious ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

  return (
    <Card span={3} title="CTEM Exposure" right={d?.total_exposures ? <span className="text-[11px] text-muted">{d.total_exposures.toLocaleString()} total</span> : null}>
      {ctem.loading ? <Skeleton h={220} /> : ctem.error || empty ? <Empty /> : (
        <table className="w-full border-collapse mt-2.5 text-sm">
          <thead>
            <tr>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Severity</th>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Priority</th>
              <th className="text-right text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Count</th>
            </tr>
          </thead>
          <tbody>
            {matrix.slice(0, 15).map((r, i) => {
              const sev = String(r.severity || '').toLowerCase()
              return (
                <tr key={sev + r.priority + i}>
                  <td className="py-2 px-2.5 border-b border-line font-medium uppercase text-[11px]" style={{ color: SEV_COLOR[sev] || COLORS.other }}>{r.severity || '—'}</td>
                  <td className="py-2 px-2.5 border-b border-line text-muted">{r.priority ?? '—'}</td>
                  <td className="py-2 px-2.5 border-b border-line text-right font-mono">{r.count ?? 0}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
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
  const cols = rows.length ? Object.keys(rows[0]).slice(0, 4) : []

  return (
    <Card span={3} title="SOC Insights">
      {insights.loading ? <Skeleton h={220} /> : insights.error || rows.length === 0 ? <Empty /> : (
        <table className="w-full border-collapse mt-2.5 text-sm">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">{c.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 15).map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className="py-2 px-2.5 border-b border-line text-muted">{typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c] ?? '—')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
