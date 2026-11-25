import { Card, Skeleton } from '../../components/ui.jsx'
import ValueStat from './ValueStat.jsx'
import PanelMissed from './PanelMissed.jsx'

// How much work the DNS and DHCP platform did, and how well, over the last 30
// days. A number whose read failed says so in words and the rest still show.
export default function ValuePlatform({ panelId, m, loading, onRetry }) {
  const stats = [m.queries, m.cache_hit, m.uptime, m.dhcp_assigned, m.roaming]
  return (
    <Card panelId={panelId} span={6} title="Platform performance — 30 days">
      {loading ? <Skeleton h={140} /> : (
        <div className="vl-panel">
          <PanelMissed stats={stats} what="platform performance" onRetry={onRetry} />
          <dl className="vl-strip">
            {stats.map((s) => (
              <div key={s.key} data-value-platform-metric={s.key} style={{ display: 'contents' }}><ValueStat s={s} /></div>
            ))}
          </dl>
        </div>
      )}
    </Card>
  )
}
