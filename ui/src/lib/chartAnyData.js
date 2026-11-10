// The pure half of Build a chart's "other Infoblox data" picker
// (tabs/ChartAnyData.jsx): settling picks, the query link, search, heading.

/** A data set's or field's name on screen: its title, or its cube name with the switch on. */
export const label = (m, cube) => (cube ? m.name : m.title || m.name)

/** Fills in what has not been picked yet, and drops a pick the data set does not have. */
export function settleAny(set, p, tops) {
  if (!set) return p
  const has = (xs, n) => xs.some((x) => x.name === n)
  const times = set.dimensions.filter((d) => d.type === 'time')
  const splits = set.dimensions.filter((d) => d.type !== 'time')
  const measure = has(set.measures, p.measure) ? p.measure : (set.measures[0]?.name ?? '')
  const split = has(splits, p.split) ? p.split : ''
  const time = has(times, p.time) ? p.time : ((times.find((d) => d.name.endsWith('.timestamp')) ?? times[0])?.name ?? '')
  const window = !time ? 'all' : (p.window ?? '7d')
  const top = split ? (tops.includes(p.top) ? p.top : 10) : 0
  return { ...p, measure, split, time, window, top }
}

/** The /api/chart/any link for settled picks. */
export function anyUrl(p) {
  const q = { cube: p.cube, measure: p.measure }
  if (p.split) Object.assign(q, { split: p.split, top: String(p.top) })
  if (p.window !== 'all') Object.assign(q, { time: p.time, window: p.window })
  return `/api/chart/any?${new URLSearchParams(q)}`
}

/** Data sets whose name, title or description holds every word searched for. */
export function findSets(cubes, text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return cubes
  return cubes.filter((c) => {
    const hay = `${c.title} ${c.name} ${c.description}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** The chart's heading: the data set, the count, the split and the window. */
export function anySentence(opts, set, p, cube) {
  if (!set) return 'Your chart'
  const name = (xs, n) => {
    const m = xs.find((x) => x.name === n)
    return m ? label(m, cube) : n
  }
  let s = `${label(set, cube)}: ${name(set.measures, p.measure)}`
  if (p.split) s += ` by ${name(set.dimensions, p.split)}, top ${p.top}`
  if (p.window !== 'all') s += `, ${(opts.windows.find((w) => w.id === p.window)?.name ?? '').toLowerCase()}`
  return s
}

/** The first sentence of a data set's description: Infoblox writes the rest as notes for its AI. */
export function firstSentence(text) {
  return (text ?? '').split(/(?<=\.)\s/)[0]
}

/**
 * A count as Infoblox sent it, as a number, or null when there is none: a
 * missing, null, blank or non-numeric value is unknown, never a real 0.
 */
export function anyValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
