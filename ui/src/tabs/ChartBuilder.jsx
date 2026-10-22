import { lazy, Suspense, useMemo, useState } from 'react'
import { useApi } from '../lib/api.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, Skeleton, TabIntro, useChartTheme } from '../components/ui.jsx'
import Switch from '../components/Switch.jsx'
import { setCubeNames, useCubeNames } from '../lib/cubeNames.js'
import {
  DEFAULT_PICKS, chartData, chartKind, chartUrl, choiceName, choicesFor, describePicks, fieldName,
  sampleTable, sentence, settlePicks, shortLabel,
} from '../lib/chartBuilder.js'

// Build a chart: plain menus in, one Cube.js query out, a chart of what the
// tenant sent back. No model is involved, so every number came from Infoblox.
// The menus, the names and the allowed combinations all come from
// /api/chart/options (dashboard/chart_builder.go); the logic is
// lib/chartBuilder.js.

// Only the panel drawing a chart waits for recharts (see charts/StatusDonut.jsx).
const CategoryBars = lazy(() => import('../charts/CategoryBars.jsx'))
const GradientArea = lazy(() => import('../charts/GradientArea.jsx'))
const StackedDayBars = lazy(() => import('../charts/StackedDayBars.jsx'))
const StatusDonut = lazy(() => import('../charts/StatusDonut.jsx'))

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

const DONUT_KEYS = ['series', 'purple', 'ok', 'warn', 'crit', 'other']

// label="Your" reads as "Your chart" to a screen reader; the panel heading
// above carries the sentence. chartSummary.test.js wants the label literal.
function TheChart({ opts, picks, rows }) {
  const { COLORS } = useChartTheme()
  const cube = useCubeNames()
  const data = useMemo(() => chartData(opts, picks, rows, cube), [opts, picks, rows, cube])
  const unit = fieldName(opts, opts.counts.find((c) => c.id === picks.count).measure, cube)
  const kind = chartKind(picks)
  return (
    <Suspense fallback={<Skeleton h={220} />}>
      {kind === 'line' ? (
        <GradientArea label="Your" data={data} color={COLORS.series} gradientId="chartBuilderFill" unit={unit} height={220} />
      ) : kind === 'stacked' ? (
        <StackedDayBars label="Your" data={data} blockedColor={COLORS.crit} allowedColor={COLORS.series} height={220} />
      ) : kind === 'donut' ? (
        <div className="h-[160px]">
          <StatusDonut
            label="Your"
            unit={unit}
            data={data.map((d, i) => ({ ...d, color: COLORS[DONUT_KEYS[i % DONUT_KEYS.length]] }))}
          />
        </div>
      ) : (
        // Domains run long; shortLabel keeps each one under its own bar.
        <CategoryBars label="Your" data={data} unit={unit} fill={COLORS.series} height={220} minTickGap={8} tickFormat={shortLabel} />
      )}
    </Suspense>
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
        <TheChart opts={opts} picks={picks} rows={result.data?.rows ?? []} />
      )}
    </Card>
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
