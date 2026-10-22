import { useState } from 'react'
import { useApi } from '../lib/api.js'
import { Card, Empty, FeedUnavailable, Skeleton, useGridLayout } from './ui.jsx'
import ChartView from './ChartView.jsx'
import { chartLink, chartUrl } from '../lib/chartBuilder.js'
import { removeChart } from '../lib/savedCharts.js'
import { saveLayout } from '../lib/layout.js'

// A chart made in Build a chart and added to a page. It is an ordinary panel
// (panelId saved-<id>), so Arrange panels moves and hides it like any other.
// It stores only the picks and redraws from the active tenant every time.

// Remove, or for a chart that replaced a built-in panel, Restore original:
// the panel comes off the page's hidden list (saved, then shown through the
// page's own grid, as "Put back" in Arrange panels does), then the chart is
// deleted.
function AboutControls({ chart, onRemoved }) {
  const grid = useGridLayout()
  const [state, setState] = useState({ busy: false, error: null })
  const remove = async () => {
    setState({ busy: true, error: null })
    try {
      if (chart.replaces && grid) {
        // Saved and waited for BEFORE the chart is deleted: if the layout
        // can't be written, the chart (and its Restore) stays.
        const snap = grid.snapshot()
        const next = { ...snap, hidden: snap.hidden.filter((id) => id !== chart.replaces) }
        await saveLayout(chart.tab, next)
        grid.apply(next, false)
      }
      await removeChart(chart.id)
      onRemoved()
    } catch (e) {
      setState({ busy: false, error: e.message })
    }
  }
  const label = chart.replaces ? 'Restore original' : 'Remove from this page'
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <a href={chartLink(chart.picks, { saved: chart.id })} className="text-note text-link underline">Open in Build a chart</a>
      <button
        type="button"
        onClick={remove}
        disabled={state.busy}
        className="rounded-control text-note text-crit underline underline-offset-2 hover:no-underline disabled:opacity-60"
      >
        {state.busy ? 'Working…' : label}
      </button>
      {state.error && <span role="alert" className="text-note text-crit">{state.error}</span>}
    </div>
  )
}

export default function SavedChart({ panelId, chart, onRemoved }) {
  const options = useApi('/api/chart/options')
  const result = useApi(chartUrl(chart.picks))
  const status = result.data?.status
  // The title is a template literal so arrangeNames.test.js can see it is
  // always text; the server refuses a saved chart with no title.
  return (
    <Card
      panelId={panelId}
      helpKey="saved-chart"
      title={`${chart.title}`}
      span={3}
      aboutExtra={<AboutControls chart={chart} onRemoved={onRemoved} />}
    >
      {options.loading || result.loading ? (
        <Skeleton h={220} />
      ) : status === 'invalid' ? (
        // The catalog changed under it: these picks are no longer offered.
        <FeedUnavailable label="Build a chart no longer offers these choices" reason={result.data?.reason} />
      ) : options.error || !options.data?.combos || result.error || status === 'error' ? (
        <FeedUnavailable label="This chart could not be drawn" reason={result.data?.reason} />
      ) : status === 'empty' ? (
        <Empty>Infoblox has no activity to count for this chart.</Empty>
      ) : (
        <ChartView label={chart.title} opts={options.data} picks={chart.picks} rows={result.data?.rows ?? []} />
      )}
    </Card>
  )
}
