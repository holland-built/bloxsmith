import { Card, Skeleton } from '../../components/ui.jsx'
import DayChart from './DayChart.jsx'
import ValueStat from './ValueStat.jsx'
import { BLOCKED_COUNTS } from './valueModel.js'
import PanelMissed from './PanelMissed.jsx'

const CHART_MISSING = {
  loading: 'Loading daily data…',
  // Why, and Try again, are said once, in the panel's own note above; here
  // the chart says only what every failed figure says.
  error: 'Daily figures: Not checked',
  empty: 'Infoblox has no daily figures for this period.',
}

// The page's headline: lookups blocked, the 30 days behind it, and the two
// security numbers that go with it. Each stands on its own if another fails.
export default function ValueSecurity({ panelId, m, loading, onRetry }) {
  return (
    <Card panelId={panelId} span={6} title="Security results — 30 days">
      {loading ? <Skeleton h={220} /> : (
        <div className="vl-panel">
          <PanelMissed stats={[m.blocked, m.zero_day, m.sus_to_mal, m.daily]} what="security results" onRetry={onRetry} />
          <section className="vl-hero">
            <div data-stat="blocked" data-state={m.blocked.state}>
              <p className={m.blocked.state === 'ok' ? 'vl-huge' : 'vl-huge vl-word'}>{m.blocked.text}</p>
              <p className="vl-hero-label">{m.blocked.label}</p>
              <p className="vl-note">{BLOCKED_COUNTS}</p>
              {m.blocked.note && <p className="vl-note">{m.blocked.note}</p>}
            </div>
            <div>
              {m.daily.state === 'ok'
                ? <DayChart daily={m.daily} />
                : <p className="vl-chart-note" data-state={m.daily.state}>{CHART_MISSING[m.daily.state]}</p>}
            </div>
          </section>
          <dl className="vl-strip">
            <ValueStat s={m.zero_day} />
            <ValueStat s={m.sus_to_mal} />
          </dl>
        </div>
      )}
    </Card>
  )
}
