import { useApi } from '../../lib/api.js'
import { Card, FeedUnavailable, Skeleton } from '../../components/ui.jsx'
import { platformRows } from '../../lib/valuePlatform.js'
import '../Overview.css'
import '../Dns.css'

// How much work the DNS and DHCP platform did, and how well, over the last 30
// days. Each number stands on its own: one whose read failed says "not
// checked" and the rest are still shown (lib/valuePlatform.js). Uptime keeps
// its per-host list folded away under the number.
export default function ValuePlatform({ panelId }) {
  const feed = useApi('/api/csp/value-platform', { poll: 300000 })
  const dead = !feed.loading && (!!feed.error || feed.data?.status === 'error')
  return (
    <Card panelId={panelId} span={3} title="How the platform ran — 30 days">
      {feed.loading && !feed.data ? (
        <Skeleton h={220} />
      ) : dead ? (
        <FeedUnavailable label="Platform numbers unavailable" />
      ) : (
        <dl className="dns-stats" style={{ flexDirection: 'column', gap: 14 }}>
          {platformRows(feed).map((r) => (
            <div key={r.key} data-value-platform-metric={r.key} data-state={r.state}>
              <dt style={{ color: 'var(--ov-ink)', fontSize: 14 }}>{r.label}</dt>
              <dd
                className={r.state === 'ok' ? undefined : 'text-muted'}
                style={r.state === 'ok' ? undefined : { fontSize: 15, fontWeight: 400 }}
              >
                {r.text}
              </dd>
              <div className="text-note text-muted">{r.line}</div>
              {r.note && r.state === 'ok' && <div className="text-note text-muted">{r.note}</div>}
              {r.hosts.length > 0 && (
                <details className="text-note">
                  <summary>Each server ({r.hosts.length})</summary>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {r.hosts.map((h) => (
                      <li key={h.name}>
                        {h.name}: {h.text}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </dl>
      )}
    </Card>
  )
}
