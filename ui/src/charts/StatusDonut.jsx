import { Cell, PieChart, Pie, Tooltip, ResponsiveContainer } from 'recharts'
import { ChartTip } from '../components/ui.jsx'

// The 130px status donut drawn by Infra ("Host Status") and by Overview (the
// same picture, plus drilldown), in its own module so it can be
// `lazy(() => import(...))`d.
//
// WHY THIS FILE EXISTS AT ALL. `charts` is already its own build chunk (see
// vite.config.js) and chart-free tabs already avoid it — but a tab that imports
// recharts at module top level makes the 383 KB chunk part of that TAB's load,
// so nothing on the page paints until it lands. Measured 2026-08-10 against the
// built app: every one of the seven chart tabs downloaded 711-721 KB before
// first paint, against 332-343 KB for provision and editor, and the entire
// difference is this one chunk. Moving the chart body behind a dynamic import
// lets the tab's tables and numbers render on the smaller payload and the chart
// arrive after. Measured again after the move: 1623 ms and 329 KB to a readable
// heading, against 2108 ms and 712 KB for a tab still importing eagerly.
//
// The markup below is a VERBATIM move out of Infra.jsx — the tooltip position,
// allowEscapeViewBox and isAnimationActive settings are each load-bearing and
// each has a test (tests/chart-tooltips.spec.ts, tests/theme.spec.ts). Colours
// still arrive as data on `data[].color`, resolved by the caller from
// useChartTheme, so this module stays theme-agnostic and does not need the
// theme context to have loaded before it can render.
//
// TWO CALLERS, TWO DIFFERENCES, AND THEY ARE THE ONLY TWO PROPS THAT VARY.
// Overview's copy is clickable — it drills into Infra filtered by the slice —
// and spells its own value ("12 hosts", singular at 1); Infra's is neither and
// names its unit instead. Geometry, the escape behaviour, and reading the label
// off the payload row rather than the axis are identical, which is why this is
// one file and not two.
export default function StatusDonut({ data, unit, valueFormat, onSliceClick }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          innerRadius={44}
          outerRadius={62}
          startAngle={90}
          endAngle={-270}
          stroke="none"
          isAnimationActive={false}
          cursor={onSliceClick ? 'pointer' : undefined}
          onClick={onSliceClick}
        >
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
        </Pie>
        {/* A pie has no category axis, so recharts hands the tooltip no
            usable `label` — the slice's name lives on the payload row.
            Reading it there keeps the first line ("Offline") that the
            default renderer used to print, with the count underneath as
            "4 hosts" instead of "Offline : 4".
            position / allowEscapeViewBox are an earlier fix for the
            tooltip being clipped by this 130px donut; carried through. */}
        <Tooltip
          content={
            <ChartTip
              name={unit}
              labelFormat={(_l, p) => p?.[0]?.name ?? ''}
              valueFormat={valueFormat}
            />
          }
          position={{ y: 100 }}
          allowEscapeViewBox={{ x: false, y: true }}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}
