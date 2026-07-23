import { useMemo, useState } from 'react'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, CardGrid, Empty, Skeleton } from '../components/ui.jsx'

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
        <SocQueue rows={actionsRows} loading={actionsApi.loading} error={actionsApi.error} />
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
                <i className="w-2 h-2 rounded-sm inline-block" style={{ background: m.color }} />
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
  const [sort, setSort] = useState({ key: 'detected_at', dir: 'desc' })

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return signals.filter((s) => {
      if (category && s.category !== category) return false
      if (!q) return true
      return [s.category, s.entity_id, s.message].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [signals, category, filter])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    arr.sort((a, b) => {
      let av, bv
      if (key === 'category') { av = a.category || ''; bv = b.category || '' }
      else if (key === 'entity_id') { av = a.entity_id || ''; bv = b.entity_id || '' }
      else if (key === 'severity') { av = sevMeta(a.severity, COLORS).key; bv = sevMeta(b.severity, COLORS).key }
      else { av = Number(a.detected_at) || 0; bv = Number(b.detected_at) || 0 }
      if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return dir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [filtered, sort])

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))
  }

  const headers = [
    { key: 'ack', label: 'Ack', noSort: true },
    { key: 'category', label: 'Category' },
    { key: 'entity_id', label: 'Entity' },
    { key: 'severity', label: 'Severity' },
    { key: 'message', label: 'Message', noSort: true },
    { key: 'detected_at', label: 'Age' },
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
        </div>
      }
    >
      {loading ? (
        <Skeleton h={280} />
      ) : error ? (
        <Empty>failed to load incidents</Empty>
      ) : signals.length === 0 ? (
        <Empty>no issues detected — all metrics within normal thresholds</Empty>
      ) : sorted.length === 0 ? (
        <Empty>no signals match</Empty>
      ) : (
        <div className="max-h-[420px] overflow-x-hidden overflow-y-auto">
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
              {sorted.map((s) => {
                const k = ackKey(s)
                const acked = !!acks[k]
                return (
                  <tr key={k} style={{ opacity: acked ? 0.45 : 1 }}>
                    <td className="py-2.5 px-2.5 border-b border-line">
                      <input type="checkbox" checked={acked} onChange={() => onToggleAck(s)} aria-label="Acknowledge signal" />
                    </td>
                    <td className="py-2.5 px-2.5 border-b border-line text-muted">{s.category || '—'}</td>
                    <td className="py-2.5 px-2.5 border-b border-line align-top">
                      <span className="block font-mono overflow-hidden whitespace-nowrap" style={{ maxWidth: 180 }} title={s.entity_id || undefined}>
                        {s.entity_id || '—'}
                      </span>
                    </td>
                    <td className="py-2.5 px-2.5 border-b border-line"><SeverityPill severity={s.severity} /></td>
                    <td className="py-2.5 px-2.5 border-b border-line text-muted break-words">{s.message || '—'}</td>
                    <td className="py-2.5 px-2.5 border-b border-line text-muted whitespace-nowrap">{ageLabel(s.detected_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ---------- SOC action queue ----------

function SocQueue({ rows, loading, error }) {
  return (
    <Card span={2} title="SOC Queue" note="IQ Actions">
      {loading ? (
        <Skeleton h={280} />
      ) : error ? (
        <Empty>failed to load actions</Empty>
      ) : rows.length === 0 ? (
        <Empty>no pending actions</Empty>
      ) : (
        <div className="max-h-[420px] overflow-x-hidden overflow-y-auto">
          <table className="w-full border-collapse mt-2.5 text-sm">
            <thead>
              <tr>
                <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Sev</th>
                <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r, i) => (
                <tr key={`${r.id ?? r.display_id ?? ''}|${i}`}>
                  <td className="py-2.5 px-2.5 border-b border-line"><SeverityPill severity={mcpSeverity(r)} /></td>
                  <td className="py-2.5 px-2.5 border-b border-line text-muted break-words">{r.title || r.name || r.message || r.display_id || r.id || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
