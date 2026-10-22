import { useState } from 'react'
import { useApi } from '../lib/api.js'
import { Card, Empty, FeedUnavailable, Skeleton } from './ui.jsx'
import ChartView from './ChartView.jsx'
import { chartUrl } from '../lib/chartBuilder.js'
import { removeChart } from '../lib/savedCharts.js'

// A chart made in Build a chart and added to a page. It is an ordinary panel
// (panelId saved-<id>), so Arrange panels moves and hides it like any other.
// It stores only the picks and redraws from the active tenant every time.

function RemoveControl({ id, onRemoved }) {
  const [state, setState] = useState({ busy: false, error: null })
  const remove = async () => {
    setState({ busy: true, error: null })
    try {
      await removeChart(id)
      onRemoved()
    } catch (e) {
      setState({ busy: false, error: e.message })
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={remove}
        disabled={state.busy}
        className="rounded-control text-note text-crit underline underline-offset-2 hover:no-underline disabled:opacity-60"
      >
        {state.busy ? 'Removing…' : 'Remove from this page'}
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
      aboutExtra={<RemoveControl id={chart.id} onRemoved={onRemoved} />}
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
