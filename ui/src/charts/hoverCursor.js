// What recharts draws behind the hovered point: a box behind a bar, a line on an
// area chart. Its default is a fixed light grey (#ccc), which on the dark theme is
// a bright slab behind the bar. Both take the theme's grid colour instead, so the
// hover looks the same on every tab and in either theme. The box is the one
// StackedDayBars already used. tests/chart-hover-box.spec.ts holds every chart to it.
export const BAR_HOVER = { fill: 'var(--color-grid)', fillOpacity: 0.35 }
export const AREA_HOVER = { stroke: 'var(--color-grid)', strokeWidth: 1 }
