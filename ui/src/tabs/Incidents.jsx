import { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, CardGrid, Empty, Skeleton } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'

// ---------- severity vocab ----------
// Signals carry crit/warn/ok (this app) or critical/high/medium/low (upstream) —
// normalize both into one palette so chips, KPIs, and the table agree.
function sevMeta(s, COLORS) {
  const v = String(s || '').toLowerCase()
  if (v === 'crit' || v === 'critical') return { key: 'critical', label: 'Critical', color: COLORS.crit }
  if (v === 'high') return { key: 'high', label: 'High', color: COLORS.sevHigh }
  if (v === 'warn' || v === 'medium') return { key: 'medium', label: 'Medium', color: COLORS.warn }
  if (v === 'low' || v === 'ok') return { key: 'low', label: 'Low', color: COLORS.accent }
  return { key: 'unknown', label: v || 'Unknown', color: COLORS.other }
}

// Sort rank so Critical > High > Medium > Low (ascending puts Critical first).
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }
function sevRank(s, COLORS) {
  return SEV_RANK[sevMeta(s, COLORS).key] ?? 4
}

// MCP IQ Actions carry priority (low/medium/high), not this app's severity vocab.
const PRIORITY_TO_SEVERITY = { low: 'low', medium: 'medium', high: 'high' }
function mcpSeverity(row) {
  if (row?.severity) return row.severity
  const p = String(row?.priority || '').toLowerCase()
  return PRIORITY_TO_SEVERITY[p] || 'low'
}

function ageLabel(epoch) {
  const t = Number(epoch)
  if (!t) return '—'
  const secs = Math.max(0, Date.now() / 1000 - t)
  if (secs < 60) return `${Math.floor(secs)}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86400)}d`
}

function SeverityPill({ severity }) {
  const { COLORS } = useChartTheme()
  const m = sevMeta(severity, COLORS)
  return (
    <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: `${m.color}22`, color: m.color }}>
      {m.label}
    </span>
  )
}

// ack identity: (category, entity_id, detected_at) — a re-broken entity is a new
// problem, not the one already dismissed (old app: incAckKey)
const ackKey = (s) => `${s.category}|${s.entity_id}|${Math.floor(Number(s.detected_at) || 0)}`

// ---------- main ----------

export default function Incidents() {
  const incApi = useApi('/api/incidents', { poll: 20000 })
  const actionsApi = useApi('/api/actions', { poll: 30000 })

  const [acks, setAcks] = useState({})
  const [category, setCategory] = useState('')
  const [openActionId, setOpenActionId] = useState(null)
  // per-action-id pending/error state for the resolve/reopen control (rows are independent)
  const [actionStatusState, setActionStatusState] = useState({})

  const categories = incApi.data?.incidents ?? []
  const signals = Array.isArray(incApi.data?.signals) ? incApi.data.signals : []

  const actionsRows = Array.isArray(actionsApi.data)
    ? actionsApi.data
    : actionsApi.data?.actions || actionsApi.data?.results || actionsApi.data?.data || []

  function toggleAck(s) {
    const k = ackKey(s)
    setAcks((p) => {
      const n = { ...p }
      if (n[k]) delete n[k]
      else n[k] = true
      return n
    })
  }

  async function setActionStatus(id, nextStatus) {
    setActionStatusState((p) => ({ ...p, [id]: { pending: true, error: null } }))
    try {
      const res = await fetch(`/api/actions/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      })
      let body = null
      try { body = await res.json() } catch { /* non-json body */ }
      if (res.status === 403) {
        setActionStatusState((p) => ({ ...p, [id]: { pending: false, error: 'operator required' } }))
        return
      }
      if (!res.ok || !body?.ok) {
        setActionStatusState((p) => ({ ...p, [id]: { pending: false, error: body?.error || `failed (${res.status})` } }))
        return
      }
      // Not optimistic: only clear pending + drop error once the server confirms,
      // then let a refetch drive the real row status.
      setActionStatusState((p) => ({ ...p, [id]: { pending: false, error: null } }))
      await actionsApi.refetch()
    } catch (e) {
      setActionStatusState((p) => ({ ...p, [id]: { pending: false, error: e?.message || 'network error' } }))
    }
  }

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Incidents</h1>
      <CardGrid>
        <CategoryChips categories={categories} loading={incApi.loading} category={category} onCategory={setCategory} />
        <SeverityKpis signals={signals} loading={incApi.loading} />
        <IncidentsTable
          signals={signals}
          loading={incApi.loading}
          error={incApi.error}
          category={category}
          onCategory={setCategory}
          acks={acks}
          onToggleAck={toggleAck}
          onClearAcks={() => setAcks({})}
        />
        <SocQueue
          rows={actionsRows}
          loading={actionsApi.loading}
          error={actionsApi.error}
          statusState={actionStatusState}
          onSetStatus={setActionStatus}
          openActionId={openActionId}
          onOpenAction={setOpenActionId}
        />
        <ActionTrendStrip rows={actionsRows} loading={actionsApi.loading} error={actionsApi.error} />
      </CardGrid>
    </div>
  )
}

// ---------- category chips ----------

function CategoryChips({ categories, loading, category, onCategory }) {
  const { COLORS } = useChartTheme()
  return (
    <Card span={6} title="Categories" note="click to filter Triage">
      {loading ? (
        <Skeleton h={40} />
      ) : categories.length === 0 ? (
        <Empty>no active categories</Empty>
      ) : (
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => {
            const on = category === c.category
            const m = sevMeta(c.severity, COLORS)
            return (
              <button
                key={c.category}
                onClick={() => onCategory(on ? '' : c.category)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs border-border bg-field"
                style={{ borderColor: on ? m.color : undefined, background: on ? `${m.color}1a` : undefined }}
              >
                <i className="w-2 h-2 rounded-sm inline-block" style={{ background: m.color }} title={m.label} />
                <span className="font-semibold" style={{ color: m.color }} aria-hidden="true">{m.label[0]}</span>
                <span className="sr-only">{m.label} severity</span>
                <span className="font-mono text-field-txt">{(Number(c.count) || 0).toLocaleString()}</span>
                <span className="text-muted">{c.category}</span>
              </button>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ---------- severity kpi row ----------

function SeverityKpis({ signals, loading }) {
  const { COLORS } = useChartTheme()
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const s of signals) {
    const m = sevMeta(s.severity, COLORS)
    if (counts[m.key] != null) counts[m.key]++
  }
  const cells = [
    { label: 'Critical', value: counts.critical, color: COLORS.crit },
    { label: 'High', value: counts.high, color: COLORS.sevHigh },
    { label: 'Medium', value: counts.medium, color: COLORS.warn },
    { label: 'Low', value: counts.low, color: COLORS.accent },
  ]

  return (
    <Card span={6} className="flex flex-row items-stretch justify-between">
      {loading ? (
        <Skeleton h={60} />
      ) : (
        cells.map((c, i) => (
          <div key={c.label} className={`flex-1 py-1 px-3 ${i < cells.length - 1 ? 'border-r border-line-2' : ''}`}>
            <div className="text-muted text-xs">{c.label}</div>
            <div className="text-2xl font-semibold tracking-tight my-1" style={{ color: c.value > 0 ? c.color : undefined }}>
              {c.value.toLocaleString()}
            </div>
          </div>
        ))
      )}
    </Card>
  )
}

// ---------- incidents table ----------

function IncidentsTable({ signals, loading, error, category, onCategory, acks, onToggleAck, onClearAcks }) {
  const { COLORS } = useChartTheme()
  const [filter, setFilter] = useState('')

  // Filter, then default-order newest-first; DataTable takes over once a header is clicked.
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return signals
      .filter((s) => {
        if (category && s.category !== category) return false
        if (!q) return true
        return [s.category, s.entity_id, s.message].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      })
      .sort((a, b) => (Number(b.detected_at) || 0) - (Number(a.detected_at) || 0))
  }, [signals, category, filter])

  const columns = [
    {
      key: 'ack',
      label: 'Ack',
      keep: true,
      render: (_v, s) => (
        <input
          type="checkbox"
          checked={!!acks[ackKey(s)]}
          onChange={() => onToggleAck(s)}
          aria-label="Acknowledge signal"
        />
      ),
    },
    { key: 'category', label: 'Category', sortable: true },
    { key: 'entity_id', label: 'Entity', mono: true, sortable: true },
    {
      key: 'severity',
      label: 'Severity',
      sortable: true,
      comparator: (a, b) => sevRank(a.severity, COLORS) - sevRank(b.severity, COLORS),
      render: (_v, s) => <SeverityPill severity={s.severity} />,
    },
    { key: 'message', label: 'Message', grow: true },
    {
      key: 'detected_at',
      label: 'Age',
      mono: true,
      sortable: true,
      comparator: (a, b) => (Number(a.detected_at) || 0) - (Number(b.detected_at) || 0),
      render: (v) => ageLabel(v),
    },
  ]

  return (
    <Card
      span={4}
      title="Triage"
      note={category ? `filtered · ${category}` : undefined}
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-[150px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          {category && (
            <button onClick={() => onCategory('')} className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm">
              Clear filter
            </button>
          )}
          <button onClick={onClearAcks} className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm">
            Clear acks
          </button>
          <span className="text-[11px] text-muted">{rows.length.toLocaleString()}</span>
        </div>
      }
    >
      {loading ? (
        <Skeleton h={280} />
      ) : error ? (
        <Empty>failed to load incidents</Empty>
      ) : signals.length === 0 ? (
        <Empty>no issues detected — all metrics within normal thresholds</Empty>
      ) : rows.length === 0 ? (
        <Empty>no signals match</Empty>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          maxHeight={420}
          rowCap={150}
          rowKey={(s) => ackKey(s)}
          rowStyle={(s) => ({ opacity: acks[ackKey(s)] ? 0.45 : 1 })}
        />
      )}
    </Card>
  )
}

// ---------- SOC action queue ----------

function SocQueue({ rows, loading, error, statusState, onSetStatus, openActionId, onOpenAction }) {
  const { COLORS } = useChartTheme()
  const columns = [
    {
      key: 'sev',
      label: 'Sev',
      sortable: true,
      comparator: (a, b) => sevRank(mcpSeverity(a), COLORS) - sevRank(mcpSeverity(b), COLORS),
      render: (_v, r) => <SeverityPill severity={mcpSeverity(r)} />,
    },
    {
      key: 'action',
      label: 'Action',
      keep: true,
      grow: true,
      render: (_v, r) => (
        <button
          type="button"
          className="line-clamp-2 text-left underline decoration-dotted underline-offset-2 hover:text-accent"
          onClick={() => onOpenAction(r.id)}
        >
          {r.title || r.name || r.message || r.display_id || r.id || '—'}
        </button>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (_v, r) => {
        const st = statusState[r.id] || {}
        const resolved = String(r.status || '').toLowerCase() === 'resolved'
        const next = resolved ? 'active' : 'resolved'
        const label = resolved ? 'Reopen' : 'Resolve'
        return (
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              disabled={st.pending}
              onClick={() => onSetStatus(r.id, next)}
              className="px-2 py-1 rounded-md border border-border bg-field text-field-txt text-[11px] disabled:opacity-50"
            >
              {st.pending ? 'saving…' : label}
            </button>
            {st.error && <span className="text-[10px] text-crit" style={{ color: COLORS.crit }}>{st.error}</span>}
          </div>
        )
      },
    },
  ]

  const right = rows.length > 0 ? <span className="text-[11px] text-muted">{rows.length.toLocaleString()}</span> : undefined

  return (
    <Card span={2} title="SOC Queue" note="IQ Actions" right={right}>
      {loading ? (
        <Skeleton h={280} />
      ) : error ? (
        <Empty>failed to load actions</Empty>
      ) : rows.length === 0 ? (
        <Empty>no pending actions</Empty>
      ) : (
        <>
          <DataTable rows={rows} columns={columns} maxHeight={420} rowCap={150} rowKey={(r, i) => `${r.id ?? r.display_id ?? ''}|${i}`} />
          {openActionId != null && <ActionDetailDrawer actionId={openActionId} onClose={() => onOpenAction(null)} />}
        </>
      )}
    </Card>
  )
}

// ---------- action detail drawer ----------

function ActionDetailDrawer({ actionId, onClose }) {
  const detail = useApi(`/api/actions/${actionId}`)

  const action = detail.data?.action || detail.data

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-[420px] bg-panel border-l border-border p-4 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Action detail</h2>
          <button type="button" onClick={onClose} className="px-2 py-1 rounded-md border border-border bg-field text-field-txt text-xs" aria-label="Close">
            Close
          </button>
        </div>
        {detail.loading ? (
          <Skeleton h={200} />
        ) : detail.error ? (
          <Empty>failed to load action detail</Empty>
        ) : !action ? (
          <Empty>action not found</Empty>
        ) : (
          <dl className="text-sm space-y-2">
            {Object.entries(action).map(([k, v]) => (
              <div key={k} className="flex flex-col border-b border-line-2 pb-1.5">
                <dt className="text-[11px] text-muted uppercase tracking-wide">{k}</dt>
                <dd className="font-mono break-words">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}

// ---------- action volume trend strip ----------

function ActionTrendStrip({ rows, loading, error }) {
  const { COLORS } = useChartTheme()

  const { byDay, byPriority } = useMemo(() => {
    const days = {}
    const pri = { low: 0, medium: 0, high: 0 }
    for (const r of rows) {
      const t = Date.parse(r.last_activity)
      if (!Number.isNaN(t)) {
        const d = new Date(t).toISOString().slice(0, 10)
        days[d] = (days[d] || 0) + 1
      }
      const p = String(r.priority || '').toLowerCase()
      if (pri[p] != null) pri[p]++
    }
    const byDay = Object.entries(days)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, count]) => ({ date: date.slice(5), count }))
    return { byDay, byPriority: pri }
  }, [rows])

  return (
    <Card span={2} title="Action Volume" note="by day">
      {loading ? (
        <Skeleton h={220} />
      ) : error ? (
        <Empty>failed to load actions</Empty>
      ) : rows.length === 0 ? (
        <Empty>no IQ actions to trend</Empty>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={byDay} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: 'var(--color-tick)', fontSize: 10 }} axisLine={{ stroke: 'var(--color-grid)' }} tickLine={false} minTickGap={20} />
              <YAxis hide />
              <Tooltip contentStyle={{ background: 'var(--color-panel)', border: '1px solid var(--color-border)', fontSize: 12 }} />
              <Bar dataKey="count" fill={COLORS.accent} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <div className="flex items-center justify-between mt-2 text-xs">
            <span style={{ color: COLORS.sevHigh }}>High {byPriority.high}</span>
            <span style={{ color: COLORS.warn }}>Medium {byPriority.medium}</span>
            <span style={{ color: COLORS.accent }}>Low {byPriority.low}</span>
          </div>
        </>
      )}
    </Card>
  )
}
