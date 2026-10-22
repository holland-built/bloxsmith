import { useState } from 'react'
import { useApi } from '../lib/api.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, Skeleton, TabIntro } from '../components/ui.jsx'
import ChartView from '../components/ChartView.jsx'
import Switch from '../components/Switch.jsx'
import { setCubeNames, useCubeNames } from '../lib/cubeNames.js'
import { SAVED_CHART_PAGES, newChartId, saveChart } from '../lib/savedCharts.js'
import {
  DEFAULT_PICKS, chartUrl, choiceName, choicesFor, describePicks, sampleTable, sentence, settlePicks,
} from '../lib/chartBuilder.js'

// Build a chart: plain menus in, one Cube.js query out, a chart of what the
// tenant sent back. No model is involved, so every number came from Infoblox.
// The menus, the names and the allowed combinations all come from
// /api/chart/options (dashboard/chart_builder.go); the logic is
// lib/chartBuilder.js.

const MENUS = [
  { level: 'count', label: 'What to count' },
  { level: 'split', label: 'Split by' },
  { level: 'window', label: 'When' },
  { level: 'over', label: 'Over time' },
  { level: 'top', label: 'How many' },
]

function Pickers({ opts, picks, onPick, cube }) {
  const choices = choicesFor(opts, picks)
  return (
    <div className="flex flex-col gap-3">
      {MENUS.map(({ level, label }) => {
        // How many has nothing to choose when no top N applies; hidden, not greyed.
        if (level === 'top' && choices.top.every((t) => !t)) return null
        const id = `chart-pick-${level}`
        return (
          <div key={level} className="flex flex-col gap-1">
            <label htmlFor={id} className="text-note text-muted">{label}</label>
            <select
              id={id}
              value={String(picks[level])}
              onChange={(e) => onPick(level, level === 'top' ? Number(e.target.value) : e.target.value)}
              className={`${FIELD_CLS} w-full`}
            >
              {choices[level].map((v) => (
                <option key={v} value={String(v)}>{choiceName(opts, level, v, cube)}</option>
              ))}
            </select>
          </div>
        )
      })}
    </div>
  )
}

function ResultPanel({ panelId, opts, picks, result, cube }) {
  const heading = sentence(opts, picks, cube)
  const status = result.data?.status
  return (
    <Card panelId={panelId} panelName="Your chart" title={heading} span={4}>
      {result.loading ? <Skeleton h={220} /> : result.error || status === 'error' ? (
        <FeedUnavailable label="This chart could not be drawn" reason={result.data?.reason} />
      ) : status === 'empty' ? (
        <Empty>Infoblox has no activity to count for these choices.</Empty>
      ) : (
        // label="Your" reads as "Your chart" to a screen reader; the panel
        // heading above carries the sentence.
        <ChartView label="Your" opts={opts} picks={picks} rows={result.data?.rows ?? []} />
      )}
      {!result.loading && !result.error && (status === 'ok' || status === 'empty') && (
        <AddToPage key={JSON.stringify(picks)} picks={picks} defaultTitle={sentence(opts, picks, false)} />
      )}
    </Card>
  )
}

// The name a saved chart's panel heading shows. Matches the server's limit
// (dashboard/saved_chart.go savedChartTitleMax).
const TITLE_MAX = 80

/**
 * "Add to a page": a name and a page, then the chart joins that page as an
 * ordinary panel. Keyed on the picks, so changing a pick closes the form and
 * clears an old "Added" line that would no longer be true of this chart.
 */
function AddToPage({ picks, defaultTitle }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle.slice(0, TITLE_MAX))
  const [tab, setTab] = useState(SAVED_CHART_PAGES[0].id)
  const [state, setState] = useState({ busy: false, error: null, added: null })
  const page = (id) => SAVED_CHART_PAGES.find((p) => p.id === id)

  if (!open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="px-3 py-1.5 rounded-control bg-accent text-on-accent text-copy font-medium"
        >
          Add to a page
        </button>
        {state.added && (
          <span role="status" className="text-note text-muted">
            Added to {page(state.added).name}. <a href={`#${state.added}`} className="text-link underline">Open {page(state.added).name}</a>
          </span>
        )}
      </div>
    )
  }

  const add = async (e) => {
    e.preventDefault()
    setState({ busy: true, error: null, added: null })
    try {
      await saveChart({ id: newChartId(), title, tab, picks })
      setState({ busy: false, error: null, added: tab })
      setOpen(false)
    } catch (err) {
      setState({ busy: false, error: err.message, added: null })
    }
  }
  return (
    <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1 min-w-[16rem] flex-1">
        <label htmlFor="chart-save-title" className="text-note text-muted">Name on the page</label>
        <input
          id="chart-save-title"
          value={title}
          maxLength={TITLE_MAX}
          required
          onChange={(e) => setTitle(e.target.value)}
          className={FIELD_CLS}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="chart-save-tab" className="text-note text-muted">Page</label>
        <select id="chart-save-tab" value={tab} onChange={(e) => setTab(e.target.value)} className={FIELD_CLS}>
          {SAVED_CHART_PAGES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <button
        type="submit"
        disabled={state.busy || !title.trim()}
        className="px-3 py-1.5 rounded-control bg-accent text-on-accent text-copy font-medium disabled:opacity-60"
      >
        {state.busy ? 'Adding…' : 'Add'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="py-1.5 text-copy text-link underline">
        Cancel
      </button>
      {state.error && <p role="alert" className="basis-full text-note text-crit">{state.error}</p>}
    </form>
  )
}

function HowPanel({ panelId, opts, picks, result, cube }) {
  const query = result.data?.query
  const table = sampleTable(opts, (result.data?.rows ?? []).slice(0, 5), cube)
  return (
    <Card panelId={panelId} title="How this chart was made" span={6}>
      {!query ? (
        result.loading ? <Skeleton h={120} /> : <Empty>No query has run yet.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-note text-muted">
            Sent to <code>{result.data.endpoint}</code> on your Infoblox account. No AI was used.
          </p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-copy">
            {describePicks(opts, picks, cube).map(({ label, text }) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="break-words">{text}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary className="text-note font-semibold cursor-pointer select-none">The query as sent</summary>
            <pre className="text-note bg-field border border-border rounded-control p-2 mt-2 overflow-x-auto">
              {JSON.stringify(query, null, 2)}
            </pre>
            {table.rows.length > 0 && (
              <div className="overflow-x-auto mt-4">
                <h3 className="text-note font-semibold mb-1">The first {table.rows.length} rows Infoblox sent back</h3>
                <table className="text-note w-full">
                  <thead>
                    <tr>
                      {table.headers.map((h, i) => (
                        <th key={i} scope="col" className="text-left font-semibold text-muted py-1 pr-4">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        {r.map((v, j) => (
                          <td key={j} className="py-1 pr-4 tabular-nums">{v}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </div>
      )}
    </Card>
  )
}

function Builder({ opts }) {
  const cube = useCubeNames()
  const [picks, setPicks] = useState(() => settlePicks(opts, DEFAULT_PICKS))
  const result = useApi(chartUrl(picks))
  const onPick = (level, value) => setPicks((p) => settlePicks(opts, { ...p, [level]: value }))
  return (
    <CardGrid layoutKey="chart">
      <Card panelId="chart-picks" title="Choose" span={2}>
        <Pickers opts={opts} picks={picks} onPick={onPick} cube={cube} />
      </Card>
      <ResultPanel panelId="chart-result" opts={opts} picks={picks} result={result} cube={cube} />
      <HowPanel panelId="chart-how" opts={opts} picks={picks} result={result} cube={cube} />
    </CardGrid>
  )
}

export default function ChartBuilder() {
  const options = useApi('/api/chart/options')
  const cube = useCubeNames()
  return (
    <div className="w-full px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-1">
        <h1 className="text-copy font-semibold tracking-tight">Build a chart</h1>
        <Switch checked={cube} onChange={setCubeNames} label="Show cube names" />
      </div>
      <TabIntro anchor="build-a-chart">
        Pick what to count and how to slice it. The app writes the query from a fixed list, runs it on your
        Infoblox account and draws what comes back. No AI is involved, so every number is Infoblox&apos;s own.
      </TabIntro>
      {options.loading ? <Skeleton h={220} /> : options.error || !options.data?.combos ? (
        <FeedUnavailable label="The chart menus could not be loaded" />
      ) : (
        <Builder opts={options.data} />
      )}
    </div>
  )
}
