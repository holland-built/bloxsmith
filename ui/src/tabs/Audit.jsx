import { useMemo, useState } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, CardGrid, Empty, Skeleton } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'

function actionColor(a, COLORS) {
  return { CREATE: COLORS.ok, DELETE: COLORS.crit, UPDATE: COLORS.accent }[a] || COLORS.other
}

function fmtTs(ts) {
  const d = new Date(ts)
  return isNaN(d) ? String(ts ?? '—') : d.toLocaleString()
}

// mono, single-line, clipped timestamp cell (reused by both tables)
function monoTs(v) {
  const s = fmtTs(v)
  return (
    <span className="block overflow-hidden whitespace-nowrap text-ellipsis font-mono text-[12px]" style={{ maxWidth: 180 }} title={s}>
      {s}
    </span>
  )
}

// ---------- main ----------

export default function Audit() {
  const data = useApi('/api/data', { poll: 30000 })
  const logs = data.data?.auditLogs ?? []

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Audit</h1>
      <CardGrid>
        <ActivitySummary logs={logs} loading={data.loading} />
        <AuditTable logs={logs} loading={data.loading} error={data.error} />
        <CspAuditTable />
      </CardGrid>
    </div>
  )
}

// ---------- activity summary ----------

function ActivitySummary({ logs, loading }) {
  const { COLORS, TT } = useChartTheme()
  const counts = { CREATE: 0, UPDATE: 0, DELETE: 0 }
  let ok = 0, fail = 0
  for (const l of logs) {
    const a = String(l.action || '').toUpperCase()
    if (counts[a] != null) counts[a]++
    if (/fail|error/i.test(l.result || '')) fail++
    else ok++
  }
  const chartData = Object.entries(counts).map(([name, value]) => ({ name, value }))
  const total = logs.length

  return (
    <Card span={2} title="Activity Summary" right={<span className="text-[11px] text-muted">last {total} events</span>}>
      {loading ? (
        <Skeleton h={200} />
      ) : total === 0 ? (
        <Empty />
      ) : (
        <>
          <div className="flex gap-4 mb-2">
            <div>
              <div className="text-[22px] font-semibold" style={{ color: COLORS.ok }}>{ok}</div>
              <div className="text-[11px] text-dim">success</div>
            </div>
            <div>
              <div className="text-[22px] font-semibold" style={{ color: COLORS.crit }}>{fail}</div>
              <div className="text-[11px] text-dim">failed</div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: 'var(--color-tick)', fontSize: 11 }} axisLine={{ stroke: 'var(--color-grid)' }} tickLine={false} />
              <YAxis hide />
              <Tooltip {...TT} />
              <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {chartData.map((d) => (
                  <Cell key={d.name} fill={actionColor(d.name, COLORS)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </Card>
  )
}

// ---------- local audit log table ----------

function ActionPill({ action }) {
  const { COLORS } = useChartTheme()
  const a = String(action || '').toUpperCase()
  const color = actionColor(a, COLORS)
  return (
    <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: `${color}22`, color }}>
      {a || '—'}
    </span>
  )
}

function AuditTable({ logs, loading, error }) {
  const [filter, setFilter] = useState('')
  const [action, setAction] = useState('')
  const [sort, setSort] = useState({ key: 'ts', dir: 'desc' })

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return logs.filter((l) => {
      if (action && String(l.action || '').toUpperCase() !== action) return false
      if (!q) return true
      return [l.user, l.action, l.resource, l.result].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [logs, filter, action])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    arr.sort((a, b) => {
      let av = a[key] ?? '', bv = b[key] ?? ''
      if (key === 'ts') { av = new Date(a.ts).getTime() || 0; bv = new Date(b.ts).getTime() || 0 }
      if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return dir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [filtered, sort])

  const columns = [
    { key: 'ts', label: 'Time', sortable: true, render: monoTs },
    {
      key: 'user',
      label: 'User',
      sortable: true,
      render: (v) => (
        <span className="block truncate max-w-[140px]" title={v}>{v || '—'}</span>
      ),
    },
    { key: 'action', label: 'Action', sortable: true, render: (v) => <ActionPill action={v} /> },
    { key: 'resource', label: 'Resource', sortable: true },
    { key: 'result', label: 'Result', sortable: true },
  ]

  return (
    <Card
      span={4}
      title="Audit Log"
      note="Bloxsmith actions"
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-[150px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          >
            <option value="">All actions</option>
            <option value="CREATE">Create</option>
            <option value="UPDATE">Update</option>
            <option value="DELETE">Delete</option>
          </select>
          {sorted.length > 0 && <span className="text-[11px] text-muted">{sorted.length}</span>}
        </div>
      }
    >
      {loading ? (
        <Skeleton h={250} />
      ) : error || logs.length === 0 ? (
        <Empty />
      ) : sorted.length === 0 ? (
        <Empty>no entries match</Empty>
      ) : (
        <DataTable
          rows={sorted}
          columns={columns}
          rowCap={50}
          maxHeight={420}
          stickyHeader
          sort={sort}
          onSort={(next) =>
            setSort((s) => (s.key === next.key ? { key: next.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: next.key, dir: 'desc' }))
          }
        />
      )}
    </Card>
  )
}

// ---------- CSP portal audit ----------

function CspAuditTable() {
  const { COLORS } = useChartTheme()
  const [q, setQ] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  function runSearch() {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    fetch(`/api/csp-audit?${params.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => setResult(j))
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }

  const rows = result?.rows ?? []

  const columns = [
    { key: 'ts', label: 'Time', render: monoTs },
    {
      key: 'user',
      label: 'Who',
      keep: true,
      render: (v, r) => (
        <span className="block truncate max-w-[160px]" title={r.user}>
          {r.user || '—'} {r.who_kind && <span className="text-dim text-[10.5px]">({r.who_kind})</span>}
        </span>
      ),
    },
    { key: 'action', label: 'Action' },
    { key: 'resource', label: 'Resource' },
    {
      key: 'result',
      label: 'Result',
      render: (v) => (
        <span className="line-clamp-2" style={{ color: /fail/i.test(v || '') ? COLORS.crit : COLORS.ok }}>{v || '—'}</span>
      ),
    },
  ]

  return (
    <Card
      span={6}
      title="CSP Portal Audit"
      note="external — Infoblox portal activity"
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Search user or resource…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            className="w-[220px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          <button onClick={runSearch} className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm">
            {loading ? 'Searching…' : 'Search'}
          </button>
          {rows.length > 0 && <span className="text-[11px] text-muted">{rows.length}</span>}
        </div>
      }
    >
      {loading ? (
        <Skeleton h={250} />
      ) : error ? (
        <Empty>search failed</Empty>
      ) : result == null ? (
        <Empty>enter a search to query the CSP audit feed</Empty>
      ) : rows.length === 0 ? (
        <Empty>no entries match</Empty>
      ) : (
        <DataTable rows={rows} columns={columns} rowCap={150} maxHeight={420} stickyHeader />
      )}
    </Card>
  )
}
