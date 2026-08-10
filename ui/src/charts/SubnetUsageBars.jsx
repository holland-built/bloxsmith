import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartTip } from '../components/ui.jsx'
import { fmtValue } from '../lib/chartFormat.js'

// Overview's "Top Subnets by Utilization", in its own module so recharts stays
// off that tab's critical path. See charts/StatusDonut.jsx for the measurement.
//
// NOT FOLDED INTO CategoryBars. This one has no CartesianGrid, hides its X
// ticks entirely (the addresses are in the tooltip, not on the axis), fades each
// bar by rank rather than colouring by category, and its bars are a drilldown
// target. That is five differences on a chart with about eight decisions in it,
// so sharing would mean a component that is mostly branches.
//
// THE FADE IS BY RANK AND IS COMPUTED HERE, not handed in as a per-row colour
// like the other charts. It is a property of the bar's POSITION in the list —
// `1 - (i / n) * 0.6` — not of the datum, so a caller resolving it would have to
// know the list length and duplicate this arithmetic to say the same thing.
export default function SubnetUsageBars({ data, color, height = 180, onBarClick }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <XAxis dataKey="addr" tick={false} axisLine={{ stroke: 'var(--color-grid)' }} tickLine={false} />
        <YAxis hide />
        {/* This panel's sentence was already the one the other ten charts are
            being moved towards ("10.61.30.0 / 177 used (69%)"), so the words
            are carried over verbatim — only the renderer changes, so that
            every tooltip in the app is now the same component. */}
        <Tooltip
          content={
            <ChartTip
              labelFormat={(_l, p) => p?.[0]?.payload?.addr ?? p?.[0]?.payload?.cidr ?? ''}
              valueFormat={(v, p) => {
                const util = p?.payload?.util
                return `${fmtValue(v)} used (${util === null || util === undefined ? '?' : fmtValue(util)}%)`
              }}
            />
          }
        />
        <Bar
          dataKey="used"
          radius={[3, 3, 0, 0]}
          isAnimationActive={false}
          cursor="pointer"
          onClick={onBarClick}
        >
          {data.map((s, i) => (
            <Cell key={i} fill={color} fillOpacity={1 - (i / data.length) * 0.6} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
