import { useMemo, useState } from 'react'
import { Cell, PieChart, Pie, Tooltip, ResponsiveContainer } from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, Empty, Skeleton, utilStatus } from '../components/ui.jsx'
import { useThemeColors } from '../lib/theme.jsx'

// ---------- main ----------

export default function Infra() {
  const data = useApi('/api/data', { poll: 30000 })
  const health = useApi('/api/csp/host-health', { poll: 15000 })
  const onprem = useApi('/api/csp/onprem-hosts', { poll: 30000 })
  const jobs = useApi('/api/csp/jobs', { poll: 15000 })
  const dfp = useApi('/api/csp/dfp', { poll: 30000 })
  const maint = useApi('/api/csp/maintenance', { poll: 60000 })

  const theme = useThemeColors()
  const hosts = data.data?.hosts ?? []
  const maintEnabled = maint.data?.enabled
  const maintOk = maint.data?.status !== 'error' && !maint.error && maintEnabled != null

  return (
    <div className="w-full px-6 py-5">
      <div className="flex items-center gap-2 mb-3">
        <h1 className="text-lg font-semibold tracking-tight">Infrastructure</h1>
        {maintOk && (
          <span
            className="text-[11px] font-medium px-2 py-0.5 rounded-full"
            style={{
              background: maintEnabled ? theme.pillWarnBg : theme.pillOkBg,
              color: maintEnabled ? theme.pillWarnFg : theme.pillOkFg,
            }}
          >
            {maintEnabled ? 'Maintenance ON' : 'Operational'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-6 gap-3">
        <HostStatus hosts={hosts} />
        <FeedCard
          span={2}
          title="Host Health"
          note="CSP"
          feed={health}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status', badge: true },
            { key: 'version', label: 'Version', mono: true },
          ]}
        />
        <FeedCard
          span={2}
          title="On-Prem Hosts"
          note="CSP"
          feed={onprem}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'ophid', label: 'OPH ID', mono: true },
            { key: 'app_count', label: 'Apps', mono: true },
          ]}
        />
        <HostTable hosts={hosts} />
        <FeedCard
          span={3}
          title="Jobs"
          note="recent"
          feed={jobs}
          columns={[
            { key: 'created_at', label: 'Created', mono: true },
            { key: 'type', label: 'Type' },
            { key: 'status', label: 'Status', badge: true },
            { key: 'user', label: 'User' },
          ]}
        />
        <FeedCard
          span={3}
          title="DFP Services"
          note="CSP"
          feed={dfp}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status', badge: true },
          ]}
        />
      </div>
    </div>
  )
}

// ---------- host status ----------

function HostStatus({ hosts }) {
  const { COLORS, TT } = useChartTheme()
  const buckets = { Active: 0, Degraded: 0, Offline: 0, Other: 0 }
  for (const h of hosts) {
    const s = h.status || ''
    if (/online|up|active/i.test(s)) buckets.Active++
    else if (/degraded|warn/i.test(s)) buckets.Degraded++
    else if (/off|down|error|fail/i.test(s)) buckets.Offline++
    else buckets.Other++
  }
  const colorMap = { Active: COLORS.accent, Degraded: COLORS.warn, Offline: COLORS.crit, Other: COLORS.other }
  const total = hosts.length
  const pieData = Object.entries(buckets)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value, color: colorMap[name] }))

  return (
    <Card span={2} title="Host Status">
      {total === 0 ? (
        <Empty />
      ) : (
        <div className="flex items-center gap-4">
          <div className="relative w-[130px] h-[130px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" innerRadius={44} outerRadius={62} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                  {pieData.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip {...TT} />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-lg font-semibold">{total.toLocaleString()}</span>
              <span className="text-dim text-[11px]">hosts</span>
            </div>
          </div>
          <div className="flex-1 flex flex-col gap-2">
            {pieData.map((d) => (
              <div key={d.name} className="flex items-center gap-1.5 text-xs">
                <i className="w-2 h-2 rounded-sm inline-block" style={{ background: d.color }} />
                <span className="text-muted flex-1">{d.name}</span>
                <b>{((d.value / total) * 100).toFixed(0)}%</b>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// ---------- generic CSP feed card ----------

function statusBadgeColor(v) {
  const s = String(v || '').toLowerCase()
  if (/online|up|active|success|complete/.test(s)) return utilStatus(0)
  if (/degraded|warn|pending|running/.test(s)) return utilStatus(80)
  if (/off|down|error|fail/.test(s)) return utilStatus(95)
  return null
}

function FeedCard({ span, title, note, feed, columns }) {
  const theme = useThemeColors()
  const rows = feed.data?.rows ?? []
  const bad = feed.error || feed.data?.status === 'error'

  return (
    <Card span={span} title={title} note={note}>
      {feed.loading && !feed.data ? (
        <Skeleton h={160} />
      ) : bad ? (
        <Empty>feed unavailable</Empty>
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-auto max-h-[260px]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 20).map((r, i) => (
                <tr key={r.id || r.name || r.created_at || i}>
                  {columns.map((c) => {
                    const v = r[c.key]
                    if (c.badge) {
                      const st = statusBadgeColor(v) || { bg: theme.pillNeutralBg, fg: theme.pillNeutralFg }
                      return (
                        <td key={c.key} className="py-2 px-2.5 border-b border-line">
                          <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: st.bg, color: st.fg }}>
                            {v || '—'}
                          </span>
                        </td>
                      )
                    }
                    return (
                      <td key={c.key} className={`py-2 px-2.5 border-b border-line ${c.mono ? 'font-mono' : ''}`}>
                        {v ?? '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ---------- host inventory table ----------

function HostTable({ hosts }) {
  const theme = useThemeColors()
  const [filter, setFilter] = useState('')
  const [type, setType] = useState('')
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' })

  const types = useMemo(() => [...new Set(hosts.map((h) => h.type).filter(Boolean))].sort(), [hosts])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return hosts.filter((h) => {
      if (type && h.type !== type) return false
      if (!q) return true
      return [h.name, h.ip, h.status, h.type].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [hosts, filter, type])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    arr.sort((a, b) => {
      const av = String(a[key] ?? '')
      const bv = String(b[key] ?? '')
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    })
    return arr
  }, [filtered, sort])

  const top50 = sorted.slice(0, 50)

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const headers = [
    { key: 'name', label: 'Name' },
    { key: 'ip', label: 'IP' },
    { key: 'status', label: 'Status' },
    { key: 'type', label: 'Type' },
  ]

  return (
    <Card
      span={6}
      title="Host Inventory"
      note={hosts.length > 50 ? `showing 50 of ${hosts.length.toLocaleString()}` : undefined}
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-[170px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          >
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      }
    >
      {hosts.length === 0 ? (
        <Empty />
      ) : top50.length === 0 ? (
        <Empty>no hosts match</Empty>
      ) : (
        <table className="w-full border-collapse mt-2.5 text-sm">
          <thead>
            <tr>
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
            {top50.map((h, i) => {
              const st = statusBadgeColor(h.status) || { bg: theme.pillNeutralBg, fg: theme.pillNeutralFg }
              return (
                <tr key={h.name + i}>
                  <td className="py-2.5 px-2.5 border-b border-line">{h.name || '—'}</td>
                  <td className="py-2.5 px-2.5 border-b border-line font-mono">{h.ip || '—'}</td>
                  <td className="py-2.5 px-2.5 border-b border-line">
                    <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: st.bg, color: st.fg }}>
                      {h.status || '—'}
                    </span>
                  </td>
                  <td className="py-2.5 px-2.5 border-b border-line text-muted">{h.type || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}
