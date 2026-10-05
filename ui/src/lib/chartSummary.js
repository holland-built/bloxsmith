import { fmtValue } from './chartFormat.js'

// What a chart says to someone who cannot see it.
//
// Every chart here is a recharts surface with role="application", and until
// this file it had no name and no description: a screen reader said
// "application" and nothing about what was drawn. Each chart now carries a
// name (its panel's title) and one or two sentences built from the same points
// it draws.
//
// The sentences are short on purpose. Up to LIST_MAX points are read out one
// by one, because a donut with three slices IS those three numbers. Past that a
// list stops being a summary, so the sentence gives the count, where the run
// starts and ends, and where it is lowest and highest.
const LIST_MAX = 6

function toNum(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

// points: [{ label, value }]. A point whose value is not a number is left out,
// which is what the chart does with it too.
export function describePoints(points, unit = '') {
  const pts = (points || [])
    .map((p, i) => {
      const label = p?.label === null || p?.label === undefined || p.label === '' ? `#${i + 1}` : String(p.label)
      return { label, value: toNum(p?.value) }
    })
    .filter((p) => p.value !== null)
  if (pts.length === 0) return 'No data.'
  const lead = unit ? `${unit[0].toUpperCase()}${unit.slice(1)}: ` : ''
  if (pts.length <= LIST_MAX) {
    return `${lead}${pts.map((p) => `${p.label} ${fmtValue(p.value)}`).join(', ')}.`
  }
  let lo = 0
  let hi = 0
  pts.forEach((p, i) => {
    if (p.value < pts[lo].value) lo = i
    if (p.value > pts[hi].value) hi = i
  })
  const first = pts[0].label
  const last = pts[pts.length - 1].label
  // A day of hourly points can start and end on the same clock time, and
  // "10:00 PM to 10:00 PM" reads as no time at all.
  const span = first === last
    ? `${lead}${pts.length} values, ending ${last}.`
    : `${lead}${pts.length} values, ${first} to ${last}.`
  // Compared as written, not as stored: 1.01 and 1.04 are both written "1",
  // and "Lowest 1 at A, highest 1 at G" would sound like a fault.
  if (fmtValue(pts[lo].value) === fmtValue(pts[hi].value)) {
    return `${span} Every value is ${fmtValue(pts[lo].value)}.`
  }
  // A label that occurs twice cannot say which point is meant, so its place does.
  const at = (i) => {
    const repeated = pts.some((p, j) => j !== i && p.label === pts[i].label)
    return repeated ? `${pts[i].label}, value ${i + 1} of ${pts.length}` : pts[i].label
  }
  return `${span} Lowest ${fmtValue(pts[lo].value)} at ${at(lo)}, highest ${fmtValue(pts[hi].value)} at ${at(hi)}.`
}

// The two props a recharts chart takes to carry a name and a description. The
// name goes in aria-label and not in `title`, because an SVG <title> also pops
// up as a browser tooltip over the whole chart, on top of the chart's own.
export function chartA11y(label, summary) {
  return { 'aria-label': `${label} chart`, desc: summary }
}
