import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, Skeleton } from '../components/ui.jsx'
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
  const auditLogsStatus = data.data?._meta?.auditLogs

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Audit</h1>
      <CardGrid>
        <ActivitySummary logs={logs} loading={data.loading} auditLogsStatus={auditLogsStatus} />
        <AuditTable logs={logs} loading={data.loading} error={data.error} auditLogsStatus={auditLogsStatus} />
        <CspAuditTable />
      </CardGrid>
    </div>
  )
}

// ---------- activity summary ----------

function ActivitySummary({ logs, loading, auditLogsStatus }) {
  const { COLORS, TT } = useChartTheme()
  const counts = { CREATE: 0, UPDATE: 0, DELETE: 0 }
  let ok = 0, fail = 0, unknown = 0
  for (const l of logs) {
    const a = String(l.action || '').toUpperCase()
    if (counts[a] != null) counts[a]++
    const r = l.result || ''
    if (/fail|error/i.test(r)) fail++
    else if (!r || /^unknown$/i.test(r)) unknown++
    else ok++
  }
  const chartData = Object.entries(counts).map(([name, value]) => ({ name, value }))
  const total = logs.length

  return (
    <Card span={2} title="Activity Summary" right={<span className="text-[11px] text-muted">last {total} events</span>}>
      {loading ? (
        <Skeleton h={200} />
      ) : total === 0 ? (
        auditLogsStatus === 'error' ? <FeedUnavailable label="Audit log feed unavailable" /> : <Empty />
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
            {unknown > 0 && (
              <div>
                <div className="text-[22px] font-semibold text-dim">{unknown}</div>
                <div className="text-[11px] text-dim">unknown</div>
              </div>
            )}
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

// The audit chain hashes each entry to the one before it, so an edited or
// deleted line is detectable. /api/audit/log carries that verdict as three
// states: chain_valid true (intact), chain_valid false + broken_index
// (tampered), or chain_verify_error (the check itself could not run). A
// fetch failure is folded into the same "could not verify" state — it must
// never be allowed to read as "chain is fine" just because nothing loaded.
function ChainVerdict({ result, error, loading }) {
  const { COLORS } = useChartTheme()
  if (loading) return null
  if (error || result == null || result.chain_verify_error) {
    return (
      <div className="text-[12px] font-medium mb-2" style={{ color: COLORS.warn }}>
        chain integrity could not be verified
      </div>
    )
  }
  if (result.chain_valid === false) {
    return (
      <div className="text-sm font-semibold mb-2" style={{ color: COLORS.crit }}>
        chain tampered — broken at entry #{result.broken_index}
      </div>
    )
  }
  if (result.chain_valid === true) {
    return <div className="text-[11px] text-dim mb-2">chain intact — no tampering detected</div>
  }
  // Unrecognized shape: same rule as a fetch failure — don't imply "fine".
  return (
    <div className="text-[12px] font-medium mb-2" style={{ color: COLORS.warn }}>
      chain integrity could not be verified
    </div>
  )
}

function AuditTable({ logs, loading, error, auditLogsStatus }) {
  const [filter, setFilter] = useState('')
  const [action, setAction] = useState('')
  const [sort, setSort] = useState({ key: 'ts', dir: 'desc' })
  const verdict = useApi('/api/audit/log', { poll: 30000 })

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
      <ChainVerdict result={verdict.data} error={verdict.error} loading={verdict.loading} />
      {loading ? (
        <Skeleton h={250} />
      ) : error || logs.length === 0 ? (
        error || auditLogsStatus === 'error' ? <FeedUnavailable label="Audit log feed unavailable" /> : <Empty />
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
  // Starts true: the mount-time load below fires before first paint reads it,
  // so the panel shows the loading skeleton instead of a flash of "enter a
  // search" while that first fetch is in flight.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // The last query actually searched (not the live input) — distinguishes
  // "nothing here yet" (mount-time load, no query typed) from "your search
  // matched nothing" (the user typed a filter that matched zero rows).
  const [lastQuery, setLastQuery] = useState('')

  function runSearch(query) {
    const searched = query ?? q
    setLoading(true)
    setError(null)
    setLastQuery(searched)
    const params = new URLSearchParams()
    if (searched) params.set('q', searched)
    fetch(`/api/csp-audit?${params.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => setResult(j))
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }

  // Every other panel in this tab auto-loads; this one used to sit on a
  // "enter a search" prompt until the user guessed to click Search, even
  // though an empty query returns the last 500 rows of real activity
  // (csp.go CSPAudit — no clauses added when q is blank). Load recent
  // activity on mount; the search box then FILTERS that same feed.
  useEffect(() => {
    runSearch('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
            onKeyDown={(e) => e.key === 'Enter' && runSearch(q)}
            className="w-[220px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          <button onClick={() => runSearch(q)} className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm">
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
      ) : rows.length === 0 ? (
        // csp.go:849-851 returns HTTP 200 with {rows:[],count:0,status:"error"}
        // on any upstream failure — a fetch that never actually searched must
        // not be reported with the same wording as a genuine empty result.
        result?.status === 'error' ? (
          <FeedUnavailable label="CSP audit feed unavailable" />
        ) : lastQuery ? (
          <Empty>no entries match</Empty>
        ) : (
          <Empty>nothing here yet</Empty>
        )
      ) : (
        <DataTable rows={rows} columns={columns} rowCap={150} maxHeight={420} stickyHeader />
      )}
    </Card>
  )
}
