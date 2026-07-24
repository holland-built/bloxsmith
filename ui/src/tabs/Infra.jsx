import { useMemo, useState } from 'react'
import { Cell, PieChart, Pie, Tooltip, ResponsiveContainer } from 'recharts'
import { useApi } from '../lib/api.js'
import { useChartTheme, Card, CardGrid, Empty } from '../components/ui.jsx'
import { DataTable, FeedCard } from '../components/DataTable.jsx'
import { useThemeColors } from '../lib/theme.jsx'
import { useHashParams } from '../lib/hash.js'

// ---------- main ----------

export default function Infra() {
  const data = useApi('/api/data', { poll: 30000 })
  const health = useApi('/api/csp/host-health', { poll: 15000 })
  const onprem = useApi('/api/csp/onprem-hosts', { poll: 30000 })
  const jobs = useApi('/api/csp/jobs', { poll: 15000 })
  const dfp = useApi('/api/csp/dfp', { poll: 30000 })
  const maint = useApi('/api/csp/maintenance', { poll: 60000 })

  const theme = useThemeColors()
  const hp = useHashParams()
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
      <CardGrid>
        <HostStatus hosts={hosts} />
        <FeedCard
          span={2}
          title="Host Health"
          note="CSP"
          feed={health}
          count
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
          limit={5}
          viewAllHref="#infra"
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'ophid', label: 'OPH ID', mono: true },
            { key: 'app_count', label: 'Apps', mono: true },
          ]}
        />
        <HostTable hosts={hosts} status={hp.status} />
        <FeedCard
          span={3}
          title="Jobs"
          note="recent"
          feed={jobs}
          count
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
                <Tooltip {...TT} position={{ y: 100 }} allowEscapeViewBox={{ x: false, y: true }} />
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

// ---------- host inventory table ----------

function statusBucket(s) {
  s = s || ''
  if (/online|up|active/i.test(s)) return 'active'
  if (/degraded|warn/i.test(s)) return 'degraded'
  if (/off|down|error|fail/i.test(s)) return 'offline'
  return 'other'
}

// Severity rank for status sort: offline first, then degraded, active, other.
const SEV_ORDER = { offline: 0, degraded: 1, active: 2, other: 3 }
function sevRank(s) {
  return SEV_ORDER[statusBucket(s)] ?? 3
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
  { key: 'status', label: 'Status', badge: true, sortable: true, comparator: (a, b) => sevRank(a.status) - sevRank(b.status) },
  { key: 'type', label: 'Type', priority: 'low' },
]

function HostTable({ hosts, status }) {
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

  const countLabel = filtered.length === hosts.length
    ? `${hosts.length.toLocaleString()} hosts`
    : `${filtered.length.toLocaleString()} of ${hosts.length.toLocaleString()}`

  return (
    <Card
      span={6}
      title={
        statusFilter ? (
          <span className="inline-flex items-center gap-2">
            Host Inventory
            <span
              onClick={() => { location.hash = 'infra' }}
              className="text-[11px] font-medium px-2 py-0.5 rounded-full cursor-pointer"
              style={{ background: theme.pillNeutralBg, color: theme.pillNeutralFg }}
            >
              status: {statusFilter} ✕
            </span>
          </span>
        ) : 'Host Inventory'
      }
      right={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">{countLabel}</span>
          <input
            placeholder="Search name, IP…"
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
