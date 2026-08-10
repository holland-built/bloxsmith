import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartTip } from '../components/ui.jsx'

// Security's blocked/allowed-per-day chart, in its own module so recharts stays
// off that tab's critical path. See charts/HostStatusDonut.jsx for the
// measurement.
//
// NOT FOLDED INTO CategoryBars, deliberately. This one stacks two named series
// with two colours, a two-key tooltip and a hover cursor, and has no
// CartesianGrid at all. Expressing that as flags on the single-series chart
// would mean four more props that only this caller ever sets, and a component
// whose body is mostly branches — the version of "reuse" that costs more than
// the duplication it removes.
export default function StackedDayBars({ data, blockedColor, allowedColor, tickFormat, height = 150 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <XAxis
          dataKey="day"
          tickFormatter={tickFormat}
          tick={{ fill: 'var(--color-tick)', fontSize: 10 }}
          axisLine={{ stroke: 'var(--color-grid)' }}
          tickLine={false}
          minTickGap={30}
        />
        <YAxis hide />
        {/* Both outcomes for the day in one hover: "Jul 31 / Blocked
            438,914 / Allowed 21,420". The colours come from the bars, so
            the tooltip and the totals above it read the same. */}
        <Tooltip
          content={<ChartTip names={{ blocked: 'Blocked', allowed: 'Allowed' }} />}
          cursor={{ fill: 'var(--color-grid)', fillOpacity: 0.35 }}
        />
        {/* Stacked, so the column height is the day's whole matched
            volume and the split is visible inside it. Allowed sits on
            top and carries the rounded cap. */}
        <Bar dataKey="blocked" stackId="day" fill={blockedColor} isAnimationActive={false} />
        <Bar dataKey="allowed" stackId="day" radius={[3, 3, 0, 0]} fill={allowedColor} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}
