import { useChartTheme, Card, Empty, Skeleton, utilStatus } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'

// ---------- main ----------

export default function Daily() {
  const data = useApi('/api/data', { poll: 30000 })
  const sec = useApi('/api/hub/security', { poll: 30000 })

  const subnets = data.data?.subnets ?? []
  const hosts = data.data?.hosts ?? []
  const zones = data.data?.zones ?? []

  return (
    <div className="max-w-[1340px] mx-auto p-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Daily Briefing</h1>
      <div className="grid grid-cols-6 gap-3">
        <IssueKpis subnets={subnets} hosts={hosts} zones={zones} loading={data.loading} />
        <SecurityToday sec={sec} />
        <TopCapacityRisks subnets={subnets} loading={data.loading} />
        <HostsAttention hosts={hosts} loading={data.loading} />
        <DnsZoneIssues zones={zones} loading={data.loading} />
      </div>
    </div>
  )
}

// ---------- KPI cards ----------

function IssueKpis({ subnets, hosts, zones, loading }) {
  const { COLORS } = useChartTheme()
  const gt85 = subnets.filter((s) => (Number(s.cidr) || 0) <= 28 && (Number(s.util) || 0) > 85).length
  const notOnline = hosts.filter((h) => !/online|active/i.test(h.status || '')).length
  const zoneIssues = zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0).length

  const cells = [
    { label: 'Subnets >85% Util', value: gt85, color: COLORS.crit },
    { label: 'Hosts Not Online', value: notOnline, color: COLORS.warn },
    { label: 'DNS Zones w/ Issues', value: zoneIssues, color: COLORS.other },
  ]

  return (
    <Card span={2} title="Open Issues" className="flex flex-col justify-between">
      {loading ? (
        <Skeleton h={160} />
      ) : (
        cells.map((c, i) => (
          <div key={c.label} className={`flex items-center justify-between py-3.5 ${i < cells.length - 1 ? 'border-b border-line-2' : ''}`}>
            <div className="text-muted text-xs">{c.label}</div>
            <div className="text-2xl font-semibold tracking-tight" style={{ color: c.value > 0 ? c.color : undefined }}>
              {c.value.toLocaleString()}
            </div>
          </div>
        ))
      )}
    </Card>
  )
}

// ---------- security today ----------

function SecurityToday({ sec }) {
  const { COLORS } = useChartTheme()
  const counts = sec.data?.counts ?? {}
  const events = sec.data?.events ?? []
  const chips = [
    { label: 'critical', value: Number(counts.critical) || 0, color: COLORS.crit },
    { label: 'high', value: Number(counts.high) || 0, color: COLORS.warn },
    { label: 'medium', value: Number(counts.medium) || 0, color: COLORS.other },
    { label: 'blocked', value: Number(sec.data?.blocked) || 0, color: COLORS.ok },
  ]

  return (
    <Card span={4} title="Security Today" right={<span className="text-[11px] text-muted">{events.length.toLocaleString()} events</span>}>
      {sec.loading ? (
        <Skeleton h={160} />
      ) : sec.error || (!sec.data) ? (
        <Empty />
      ) : (
        <div className="grid grid-cols-4 gap-3 mt-1">
          {chips.map((c) => (
            <div key={c.label} className="text-center py-4 rounded-lg bg-line/40">
              <div className="text-2xl font-semibold tracking-tight" style={{ color: c.value > 0 ? c.color : undefined }}>
                {c.value.toLocaleString()}
              </div>
              <div className="text-[11px] text-muted mt-1 capitalize">{c.label}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------- top capacity risks ----------

function TopCapacityRisks({ subnets, loading }) {
  const rows = [...subnets]
    .filter((s) => (s.addr || s.cidr) && (Number(s.cidr) || 0) <= 28)
    .map((s) => ({ ...s, free: (Number(s.total) || 0) - (Number(s.used) || 0) }))
    .sort((a, b) => a.free - b.free)
    .slice(0, 10)

  return (
    <Card span={3} title="Top Capacity Risks" note="least free space, excl. infra links" right={<span className="text-[11px] text-muted">top 10</span>}>
      {loading ? (
        <Skeleton h={220} />
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <table className="w-full border-collapse mt-2 text-sm">
          <thead>
            <tr>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Network</th>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Site</th>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Util</th>
              <th className="text-left text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2">Free</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => {
              const util = Number(s.util) || 0
              const status = utilStatus(util)
              return (
                <tr key={(s.addr || s.cidr || '') + i}>
                  <td className="py-2 px-2.5 border-b border-line font-mono">{s.addr || s.cidr}</td>
                  <td className="py-2 px-2.5 border-b border-line">{s.site || '—'}</td>
                  <td className="py-2 px-2.5 border-b border-line">
                    <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: status.bg, color: status.fg }}>
                      {util}%
                    </span>
                  </td>
                  <td className="py-2 px-2.5 border-b border-line text-muted">{s.free.toLocaleString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ---------- hosts needing attention ----------

function HostsAttention({ hosts, loading }) {
  const { COLORS } = useChartTheme()
  const rows = hosts.filter((h) => !/online|active/i.test(h.status || '')).slice(0, 10)

  return (
    <Card span={3} title="Hosts Needing Attention" right={<span className="text-[11px] text-muted">{rows.length} shown</span>}>
      {loading ? (
        <Skeleton h={220} />
      ) : rows.length === 0 ? (
        <Empty>all hosts online</Empty>
      ) : (
        <div className="flex flex-col gap-1 mt-1">
          {rows.map((h, i) => (
            <div key={(h.name || h.ip || '') + i} className="flex items-center gap-2.5 py-1.5 border-b border-line last:border-0">
              <i className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: COLORS.crit }} />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{h.name || '—'}</div>
                <div className="text-[11px] text-dim font-mono truncate">{h.ip || ''}</div>
              </div>
              <span className="text-[11px] text-muted shrink-0">{h.status || '—'}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------- DNS zone issues ----------

function DnsZoneIssues({ zones, loading }) {
  const rows = zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0).slice(0, 10)

  return (
    <Card span={6} title="DNS Zone Issues" right={<span className="text-[11px] text-muted">{rows.length} zones</span>}>
      {loading ? (
        <Skeleton h={160} />
      ) : rows.length === 0 ? (
        <Empty>no DNS zone issues</Empty>
      ) : (
        <div className="flex flex-col gap-1 mt-1">
          {rows.map((z, i) => (
            <div key={(z.fqdn || '') + i} className="flex items-start gap-2.5 py-1.5 border-b border-line last:border-0">
              <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium shrink-0" style={{ background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)' }}>
                {z.issues.length}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-mono truncate">{z.fqdn || '—'}</div>
                <div className="text-[11px] text-dim truncate">{z.issues.join(', ')}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
