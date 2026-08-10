import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartTip } from '../components/ui.jsx'

// The gradient-filled area chart Dns draws twice — queries per second, and
// query volume by day — in its own module so recharts stays off that tab's
// critical path. See charts/HostStatusDonut.jsx for the measurement.
//
// `gradientId` IS A REQUIRED PROP AND NOT A DETAIL. The <linearGradient> is
// referenced by `fill="url(#id)"`, and an SVG id is document-global. Both of
// this tab's charts can be on screen at once, so a hardcoded id here would have
// the second chart paint itself with the first one's colour. The two callers
// keep the ids they already had (`qpsFill`, `volFill`).
//
// The colour arrives as a prop rather than being read from the theme context,
// so this lazily-loaded chunk can render the moment it lands instead of waiting
// on a provider. Axis styling reads the CSS custom properties directly, which
// is the same value `useThemeColors()` resolves (lib/theme.jsx:77-78) by a
// shorter route, and follows a theme switch without a re-render.
export default function GradientArea({
  data,
  color,
  gradientId,
  unit,
  height = 200,
  tickFormat,
  yDomain,
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--color-grid)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          tickFormatter={tickFormat}
          tick={{ fill: 'var(--color-tick)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--color-grid)' }}
          tickLine={false}
          minTickGap={40}
        />
        <YAxis hide domain={yDomain} />
        <Tooltip content={<ChartTip name={unit} />} />
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.8} fill={`url(#${gradientId})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
