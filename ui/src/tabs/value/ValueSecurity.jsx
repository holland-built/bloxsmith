import { useApi } from '../../lib/api.js'
import { valueSecurity } from '../../lib/valueSecurity.js'
import { Card, FeedUnavailable, Skeleton } from '../../components/ui.jsx'
import './ValueSecurity.css'

// What Infoblox stopped in the last 30 days, as three big numbers a manager
// can repeat. Each number stands on its own: one that could not be read says
// so in words and the others still show (lib/valueSecurity.js).
export default function ValueSecurity({ panelId }) {
  // Thirty-day totals move slowly; once every five minutes is plenty.
  const feed = useApi('/api/csp/value-security', { poll: 300000 })
  const dead = !feed.loading && (!!feed.error || feed.data?.status === 'error')
  return (
    <Card panelId={panelId} span={2} title="What Infoblox stopped — 30 days">
      {feed.loading && !feed.data ? (
        <Skeleton h={120} />
      ) : dead ? (
        <FeedUnavailable label="Security numbers not checked" />
      ) : (
        <dl className="value-sec">
          {valueSecurity(feed).map((x) => (
            <div key={x.key} data-value-security={x.key} data-state={x.state}>
              <dt>{x.label}</dt>
              <dd className={x.state === 'ok' ? 'value-sec-num' : 'value-sec-num value-sec-none text-muted'}>{x.text}</dd>
              {x.note && <dd className="value-sec-note text-muted">{x.note}</dd>}
            </div>
          ))}
        </dl>
      )}
    </Card>
  )
}
