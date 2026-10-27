import { lazy, Suspense, useMemo } from 'react'
import { Skeleton, useChartTheme } from './ui.jsx'
import { useCubeNames } from '../lib/cubeNames.js'
import { chartData, chartKind, fieldName, shortLabel, sideways, wideLabel } from '../lib/chartBuilder.js'

// The chart Build a chart draws for a set of picks, shared by the builder and
// by every chart saved onto a page (SavedChart.jsx), so a saved chart looks
// exactly like the one that was saved.

// Only the panel drawing a chart waits for recharts (see charts/StatusDonut.jsx).
const CategoryBars = lazy(() => import('../charts/CategoryBars.jsx'))
const GradientArea = lazy(() => import('../charts/GradientArea.jsx'))
const StackedDayBars = lazy(() => import('../charts/StackedDayBars.jsx'))
const StatusDonut = lazy(() => import('../charts/StatusDonut.jsx'))

const DONUT_KEYS = ['series', 'purple', 'ok', 'warn', 'crit', 'other']

/** The chart for one set of picks. label names it for a screen reader ("<label> chart"). */
export default function ChartView({ label, opts, picks, rows, barHref }) {
  const { COLORS } = useChartTheme()
  const cube = useCubeNames()
  const data = useMemo(() => chartData(opts, picks, rows, cube), [opts, picks, rows, cube])
  const unit = fieldName(opts, opts.counts.find((c) => c.id === picks.count).measure, cube)
  const kind = chartKind(picks)
  return (
    <Suspense fallback={<Skeleton h={220} />}>
      {kind === 'line' ? (
        <GradientArea label={label} data={data} color={COLORS.series} gradientId="chartBuilderFill" unit={unit} height={220} />
      ) : kind === 'stacked' ? (
        <StackedDayBars label={label} data={data} blockedColor={COLORS.crit} allowedColor={COLORS.series} height={220} />
      ) : kind === 'donut' ? (
        <div className="h-[160px]">
          <StatusDonut
            label={label}
            unit={unit}
            data={data.map((d, i) => ({ ...d, color: COLORS[DONUT_KEYS[i % DONUT_KEYS.length]] }))}
          />
        </div>
      ) : kind === 'number' ? (
        <BigNumber label={label} name={data[0].name} value={data[0].value} />
      ) : sideways(data) ? (
        // Names too long to sit under a bar (domains, policies) get a row each.
        <CategoryBars
          label={label}
          data={data}
          unit={unit}
          fill={COLORS.series}
          height={Math.max(160, data.length * 26 + 8)}
          tickFormat={wideLabel}
          horizontal
          values
          barHref={barHref}
        />
      ) : (
        <CategoryBars label={label} data={data} unit={unit} fill={COLORS.series} height={220} minTickGap={8} tickFormat={shortLabel} values barHref={barHref} />
      )}
    </Suspense>
  )
}

// One total. An average (queries per second) keeps one decimal; a count has none.
function BigNumber({ label, name, value }) {
  const text = value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return (
    <div role="img" aria-label={`${label} chart: ${name}, ${text}`} className="h-[160px] flex flex-col items-center justify-center gap-1">
      <span className="text-figure font-semibold tabular-nums">{text}</span>
      <span className="text-note text-muted">{name}</span>
    </div>
  )
}
