import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartTip } from '../components/ui.jsx'

// The bar chart three tabs draw — Audit's "Activity Summary", Network's subnet
// utilisation buckets, Incidents' IQ action trend — in its own module so
// recharts stays off those tabs' critical path. See charts/HostStatusDonut.jsx
// for the measurement that motivated the split.
//
// EVERY PROP BELOW HAS A REAL CALLER; none is here for a future one. Audit
// varies nothing but the unit, Network needs a visible Y axis and keys its rows
// on `label`, Incidents keys on `date`/`count`, formats its ticks and uses one
// flat colour instead of a colour per bar. That is the whole option surface.
//
// COLOURS ARRIVE AS DATA OR AS ONE `fill`, they are never looked up here. A row
// may carry its own resolved `color` (Audit, Network); a caller with one colour
// for every bar passes `fill` instead (Incidents). Either way this module never
// touches the theme context, which matters for a lazily-loaded chunk: it can
// render the moment it arrives rather than waiting on a provider.
//
// The axis styling reads CSS custom properties for the same reason. That is not
// a substitution — `useThemeColors()` resolves `grid` and `tick` by reading
// exactly these two variables (lib/theme.jsx:77-78), so this is the same value
// by a shorter route, and it follows a theme switch without a re-render.
// `minTickGap` is stated by the caller rather than inferred from whether a
// `tickFormat` was passed. The inference was written first and was wrong the
// moment a fourth caller appeared: Security's hourly chart wants a 30px gap
// while formatting nothing, which the rule "formatted axes are the dense ones"
// cannot express. A guess that holds for three call sites and silently
// misrenders the fourth is worse than a prop.
//
// `tickSize` USED to sit beside it, defaulting to 11 with two callers passing
// 10. Under a three-size scale 10px is not a size, and an axis tick is a label,
// so every tick in the app is --text-note and there is nothing left for a
// caller to choose. Density is what those two callers actually wanted, and
// minTickGap already says that without also making the text smaller.
export default function CategoryBars({
  data,
  unit,
  height = 140,
  xKey = 'name',
  yKey = 'value',
  showY = false,
  tickFormat,
  fill,
  minTickGap,
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-grid)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey={xKey}
          tickFormatter={tickFormat}
          tick={{ fill: 'var(--color-tick)', className: 'text-note' }}
          axisLine={{ stroke: 'var(--color-grid)' }}
          tickLine={false}
          minTickGap={minTickGap}
        />
        {showY ? (
          <YAxis tick={{ fill: 'var(--color-tick)', className: 'text-note' }} axisLine={{ stroke: 'var(--color-grid)' }} tickLine={false} allowDecimals={false} />
        ) : (
          <YAxis hide />
        )}
        {/* The bar's own category is the hover's first line, so the number
            underneath only needs its unit. */}
        <Tooltip content={<ChartTip name={unit} />} />
        <Bar dataKey={yKey} fill={fill} radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {fill
            ? null
            : data.map((d) => <Cell key={d[xKey]} fill={d.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
