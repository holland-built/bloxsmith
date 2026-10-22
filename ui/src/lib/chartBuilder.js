import { fmtShortDay } from './chartFormat.js'

// The Build a chart tab's logic, kept out of the .jsx so `node --test` can run
// it (chartBuilder.test.js).
//
// Everything here reads `opts`, the server's /api/chart/options payload. The
// plain names and the list of allowed combinations live in Go
// (dashboard/chart_builder.go); this file never keeps its own copy, so the
// menus cannot offer a pick the server would refuse.

// Menu order, which is also the order picks depend on each other: a choice is
// offered only if some allowed combination has it alongside every pick above.
const LEVELS = ['count', 'split', 'window', 'over', 'top']
const LISTS = { count: 'counts', split: 'splits', window: 'windows', over: 'overs' }

export const DEFAULT_PICKS = { count: 'dns', split: 'device', window: '7d', over: 'none', top: 10 }

function allowedAt(opts, picks, i) {
  const level = LEVELS[i]
  const out = []
  for (const c of opts.combos) {
    if (LEVELS.slice(0, i).every((l) => String(c[l]) === String(picks[l])) && !out.includes(c[level])) {
      out.push(c[level])
    }
  }
  return out
}

/** The choices each menu can show for these picks. Top is [0] when no top N applies. */
export function choicesFor(opts, picks) {
  return Object.fromEntries(LEVELS.map((l, i) => [l, allowedAt(opts, picks, i)]))
}

/** The picks with any that stopped fitting moved to the first choice that does. */
export function settlePicks(opts, picks) {
  const out = {}
  LEVELS.forEach((l, i) => {
    const allowed = allowedAt(opts, out, i)
    out[l] = allowed.find((v) => String(v) === String(picks[l])) ?? allowed[0]
  })
  return out
}

/** Over time draws a line (stacked bars when split), record types a donut, the rest bars. */
export function chartKind(picks) {
  if (picks.over !== 'none') return picks.split === 'none' ? 'line' : 'stacked'
  return picks.split === 'qtype' ? 'donut' : 'bars'
}

function choice(opts, level, id) {
  return opts[LISTS[level]].find((c) => c.id === id)
}

function countOf(opts, picks) {
  return choice(opts, 'count', picks.count)
}

/** A menu entry's label: the plain name, or the cube name with the switch on. */
export function choiceName(opts, level, id, cube) {
  if (level === 'top') return cube ? `limit ${id}` : `Top ${id}`
  const c = choice(opts, level, id)
  if (!cube) return c.name
  if (level === 'count') return c.measure
  if (level === 'split') return c.fields?.join(', ') || 'none'
  return c.value || 'none'
}

/** A field's label. "Cube.timestamp.day" reads as the timestamp's plain name. */
export function fieldName(opts, field, cube) {
  if (cube) return field
  if (opts.names[field]) return opts.names[field]
  const dot = field.lastIndexOf('.')
  return (dot > 0 && opts.names[field.slice(0, dot)]) || field
}

// Matched without regard to case: the tenant sends "Block", and older notes
// and Security.jsx spell it "block". A blank matches a "" key ("Not graded"),
// and a value with no name takes the field's otherValues pattern if it has one
// ("Answer code 5"), so nothing is dropped or left as a bare number.
function valueName(opts, field, value, cube) {
  if (cube) return value
  const names = opts.values?.[field] ?? {}
  const key = Object.keys(names).find((k) => k.toLowerCase() === String(value).toLowerCase())
  if (key !== undefined) return names[key]
  const other = opts.otherValues?.[field]
  return other ? other.replace('%s', String(value)) : value
}

/** One sentence saying what the chart shows. */
export function sentence(opts, picks, cube) {
  const count = countOf(opts, picks)
  const split = choice(opts, 'split', picks.split)
  const window = choice(opts, 'window', picks.window)
  const over = choice(opts, 'over', picks.over)
  if (cube) {
    const by = [...(split.fields ?? [])]
    if (over.value) by.push(`${count.cube}.timestamp.${over.value}`)
    const top = picks.top > 0 ? `, limit ${picks.top}` : ''
    return `${count.measure}${by.length ? ` by ${by.join(', ')}` : ''}, ${window.value}${top}`
  }
  const when = window.name.toLowerCase()
  // The catalog gives each top N split its plural ("policies", not
  // "policys"). What happened has none: it says its values instead
  // ("blocked vs allowed"), since "Top 5 what happeneds" reads oddly.
  if (picks.top > 0 && split.plural) {
    return `Top ${picks.top} ${split.plural} by ${count.name}, ${when}`
  }
  const named = !split.plural && split.fields?.length === 1 ? opts.values?.[split.fields[0]] : null
  let head = count.name
  if (over.value) head += ` ${over.name.toLowerCase()}`
  if (named) {
    // Blocked first, the order the stacked chart draws them in. The server's
    // map arrives in key order, which would put Allow first.
    const words = Object.entries(named)
      .sort(([a], [b]) => (b.toLowerCase() === 'block') - (a.toLowerCase() === 'block'))
      .map(([, v]) => v.toLowerCase())
    head += `, ${words.join(' vs ')}`
  }
  return `${head}, ${when}`
}

/**
 * "How this chart was made" as short labelled lines, one per pick that
 * applies: Counted, Split by, When, Over time, Showing (the top N) and Only
 * counting (a fixed filter the count carries, such as the qps metric).
 */
export function describePicks(opts, picks, cube) {
  const count = countOf(opts, picks)
  const lines = [{ label: 'Counted', text: choiceName(opts, 'count', picks.count, cube) }]
  if (picks.split !== 'none') lines.push({ label: 'Split by', text: choiceName(opts, 'split', picks.split, cube) })
  lines.push({ label: 'When', text: choiceName(opts, 'window', picks.window, cube) })
  if (picks.over !== 'none') lines.push({ label: 'Over time', text: choiceName(opts, 'over', picks.over, cube) })
  if (picks.top > 0) {
    lines.push({ label: 'Showing', text: cube ? `limit ${picks.top}, ${count.measure} desc` : `Top ${picks.top}, highest first` })
  }
  for (const f of count.filters ?? []) {
    const values = f.values.map((v) => valueName(opts, f.member, v, cube)).join(cube ? ', ' : ' or ')
    lines.push({
      label: 'Only counting',
      text: cube ? `${f.member} ${f.operator} ${values}` : `rows where ${fieldName(opts, f.member, false)} is ${values}`,
    })
  }
  return lines
}

const LABEL_MAX = 20

/**
 * A bar label short enough to sit under its bar: the start and end, "…"
 * between. One argument only: recharts calls a tick formatter with the index
 * second, which must not be read as a length.
 */
export function shortLabel(s) {
  const t = String(s)
  if (t.length <= LABEL_MAX) return t
  const tail = Math.floor((LABEL_MAX - 1) / 2)
  return `${t.slice(0, LABEL_MAX - 1 - tail)}…${t.slice(-tail)}`
}

const num = (v) => Number(v) || 0

function timeLabel(s, granularity) {
  if (granularity === 'hour' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(11, 16)
  return fmtShortDay(s)
}

/**
 * The rows in the shape the chart for these picks takes:
 * line [{label, value}], stacked [{day, blocked, allowed}], bars and donut [{name, value}].
 */
export function chartData(opts, picks, rows, cube) {
  const count = countOf(opts, picks)
  const granularity = choice(opts, 'over', picks.over).value
  const kind = chartKind(picks)
  if (kind === 'line' || kind === 'stacked') {
    const tKey = `${count.cube}.timestamp.${granularity}`
    const timeOf = (r) => String(r[tKey] ?? r[`${count.cube}.timestamp`] ?? '')
    const sorted = [...rows].sort((a, b) => timeOf(a).localeCompare(timeOf(b)))
    if (kind === 'line') {
      return sorted.map((r) => ({ label: timeLabel(timeOf(r), granularity), value: num(r[count.measure]) }))
    }
    // StackedDayBars draws two series. Blocked is one; every other outcome
    // (allowed, and any the tenant adds) goes in the other, so no hit is lost.
    const [actionField] = choice(opts, 'split', picks.split).fields
    const byTime = new Map()
    for (const r of sorted) {
      const t = timeOf(r)
      if (!byTime.has(t)) byTime.set(t, { day: timeLabel(t, granularity), blocked: 0, allowed: 0 })
      const bucket = byTime.get(t)
      if (String(r[actionField]).toLowerCase() === 'block') bucket.blocked += num(r[count.measure])
      else bucket.allowed += num(r[count.measure])
    }
    return [...byTime.values()]
  }
  const fields = choice(opts, 'split', picks.split).fields
  const named = rows.map((r) => {
    const field = fields.find((f) => r[f] !== undefined && r[f] !== null && r[f] !== '') ?? fields[0]
    return { name: String(valueName(opts, field, r[field] ?? '', cube)), value: num(r[count.measure]), row: r, field }
  })
  // One field: rows that read the same (a blank and a missing severity are
  // both "Not graded") are one bar, not two, re-sorted so the merged total
  // keeps "highest first" true.
  if (fields.length === 1) {
    const merged = new Map()
    for (const { name, value } of named) merged.set(name, (merged.get(name) ?? 0) + value)
    return [...merged].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }
  // Two devices can share a name; the next field (the address) tells them apart.
  return named.map(({ name, value, row, field }) => {
    const rest = fields.slice(fields.indexOf(field) + 1).map((f) => row[f]).filter(Boolean)
    const twice = named.filter((n) => n.name === name).length > 1
    return { name: twice && rest.length ? `${name} (${rest.join(', ')})` : name, value }
  })
}

/**
 * The first rows as a table: {headers, rows} of strings. A bare "Cube.timestamp"
 * column is dropped when "Cube.timestamp.<slice>" is there too, because Cube
 * sends both and they hold the same value.
 */
export function sampleTable(opts, rows, cube) {
  if (!rows.length) return { headers: [], rows: [] }
  const keys = Object.keys(rows[0])
  const cols = keys.filter((k) => !keys.some((other) => other.startsWith(`${k}.`)))
  return {
    headers: cols.map((c) => fieldName(opts, c, cube)),
    rows: rows.map((r) => cols.map((c) => String(valueName(opts, c, r[c] ?? '', cube)))),
  }
}

/** The GET that runs these picks. */
export function chartUrl(picks) {
  const q = new URLSearchParams({ count: picks.count, split: picks.split, window: picks.window, over: picks.over })
  if (picks.top > 0) q.set('top', String(picks.top))
  return `/api/chart?${q}`
}
