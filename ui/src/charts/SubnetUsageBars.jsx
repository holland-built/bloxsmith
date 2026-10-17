import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartTip } from '../components/ui.jsx'
import { fmtValue } from '../lib/chartFormat.js'
import { chartA11y, describePoints } from '../lib/chartSummary.js'

// Overview's "Top Subnets by Utilization", in its own module so recharts stays
// off that tab's critical path. See charts/StatusDonut.jsx for the measurement.
//
// NOT FOLDED INTO CategoryBars. This one has no CartesianGrid, hides its X
// ticks entirely (the addresses are in the tooltip, not on the axis), paints
// every bar one colour rather than colouring by category, and its bars are a
// drilldown target. That is five differences on a chart with about eight
// decisions in it, so sharing would mean a component that is mostly branches.
//
// NO FADE BY RANK. The bars used to dim from first to last; the height already
// says the rank, so the fade said it twice and made the last bars look disabled.
export default function SubnetUsageBars({ label, data, color, height = 180, onBarClick }) {
  // Named the way the tooltip names a bar: its address, else its CIDR.
  const summary = describePoints(data.map((s) => ({ label: s.addr ?? s.cidr, value: s.used })), 'addresses used')
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} {...chartA11y(label, summary)}>
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
          fill={color}
          radius={[3, 3, 0, 0]}
          isAnimationActive={false}
          cursor="pointer"
          onClick={onBarClick}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
