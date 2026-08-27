import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useThemeColors } from '../lib/theme.jsx'
import { Card, Empty, Skeleton, usePanelFit, utilStatus } from './ui.jsx'
import { feedCountLabel, feedCountTitle } from '../lib/feedCount.js'

// ---------- extracted shared helpers ----------

// Maps a status-ish string to a pill color (reuses utilStatus tokens). null => neutral.
export function statusBadgeColor(v) {
  const s = String(v || '').toLowerCase()
  if (/online|up|active|success|complete/.test(s)) return utilStatus(0)
  if (/degraded|warn|pending|running/.test(s)) return utilStatus(80)
  if (/off|down|error|fail/.test(s)) return utilStatus(95)
  return null
}

// Toggle a {key,dir} sort object for `key`: same key flips dir, new key => asc.
export function toggleSort(cur, key) {
  return cur && cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
}

// Sort a copy of `rows` by a controlled {key,dir} sort using a per-key accessor
// map ({ key: (row) => value }). Does the string(localeCompare)/number branch once
// so callers stop re-implementing it. Falls back to row[key] for unmapped keys.
export function sortRows(rows, sort, accessors) {
  if (!sort || !sort.key) return rows
  const { key, dir } = sort
  const get = accessors[key] || ((r) => r[key])
  return [...rows].sort((a, b) => {
    const av = get(a)
    const bv = get(b)
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return dir === 'asc' ? av - bv : bv - av
  })
}

// ---------- internals ----------

const EMPTY_MARKERS = new Set([null, undefined, '', '—', '-'])
function isEmptyCell(v) {
  return EMPTY_MARKERS.has(v)
}

function defaultCompare(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

// A column is protected from auto-hide if it carries its own render/badge/action
// or is explicitly kept — these can be meaningful even when the raw value is empty.
function isProtected(c) {
  return !!(c.keep || c.render || c.badge)
}

// Decide which columns survive auto-hide. Evaluated over the FULL sorted rows.
function visibleColumns(columns, sorted) {
  const kept = columns.filter((c) => {
    if (isProtected(c)) return true
    const values = sorted.map((r) => r[c.key])
    const nonEmpty = values.filter((v) => !isEmptyCell(v))
    if (nonEmpty.length === 0) return false // every cell empty -> hide
    if (c.hideWhenConstant) {
      const first = nonEmpty[0]
      if (nonEmpty.every((v) => v === first)) return false // all identical -> hide
    }
    return true
  })
  // Never hide the last remaining column.
  return kept.length === 0 ? columns : kept
}

// ---------- measured auto-sizer ----------
//
// table-auto (browser content sizing) and CSS percentage max-width were both
// tried and both measurably fail: nowrap hug columns can't shrink below their
// own text width, so a column with unbounded content (an opaque UUID, a long
// resource path) pushes the whole table past its wrapper — and a percentage
// max-width on a cell is circular under table-layout:auto, so browsers just
// ignore it. The only way to GUARANTEE the sum of column widths never exceeds
// the wrapper is to measure the real text with a canvas 2D context, compute
// explicit pixel widths ourselves, and render with table-fixed. Once widths
// that sum to <= the container are set explicitly, overflow is arithmetically
// impossible — that's the property neither table-auto nor CSS could give us.
//
// Column intent still drives the numbers, it just feeds the measurer instead
// of the browser:
//   - hug (default): natural = max(header, visible-row text) + padding.
//   - grow: true: one or more columns share the leftover width equally (or
//     absorb a proportional cut first if the table doesn't fit).
//   - maxCh: <number> hard px ceiling (converted via measured '0' width),
//     for a known-pathological column.
//   - width: fixed, unshrinkable, excluded from the grow/shrink pool.
// If nothing fits even at each column's floor (~6ch or 60px, whichever is
// smaller), columns shrink toward that floor widest-first and stop — the
// floor exists so text remains legible, not to guarantee zero overflow at
// any cost.

const CELL_PAD = 20 // px-2.5 on both sides of a th/td
const SORT_AFFORDANCE_PAD = 14 // room for the ▲/▼ indicator on a sortable header
const MEASURE_BUFFER = 3 // absorbs measureText() sub-pixel rounding
const BADGE_PAD = 20 // the pill span's own px-2.5
const SHRINK_FLOOR_CH = 6
const SHRINK_FLOOR_MAX = 60
const RESIZE_TOLERANCE = 1 // px; ignore sub-pixel ResizeObserver noise

function widthsEqual(a, b) {
  if (!a || !b) return a === b
  const ak = Object.keys(a.widths)
  const bk = Object.keys(b.widths)
  if (ak.length !== bk.length) return false
  return ak.every(
    (k) => Math.abs((a.widths[k] ?? 0) - (b.widths[k] ?? 0)) <= RESIZE_TOLERANCE && !!a.clipMarked[k] === !!b.clipMarked[k],
  )
}

// How a column was SIZED, published on its <th> so a test can tell the cases
// apart from the outside. Without it the DOM cannot distinguish DataTable's own
// badge pill from a `render` column whose caller hand-rolls the identical pill
// markup (Overview's subnet table does exactly that), and the two have opposite
// width invariants: a badge column is never in the grow set, so it may never be
// wider than its content needs, while a render column legitimately absorbs
// leftover width. tests/table-measures-what-it-paints.spec.ts is the consumer.
// One attribute per COLUMN, on the header — not per cell, which would repeat it
// up to rowCap times.
//
// THE ORDER IS THE RENDER PATH'S ORDER and has to stay that way. Infra's
// host-inventory status column declares `badge: true` AND `render`
// (tabs/Infra.jsx), and both the tbody and measure() test `render` first, so a
// column like that is painted and measured as a render column. Calling it a
// badge would hand it to the opposite invariant.
// rowName is what a screen reader hears instead of the row's own text, because
// aria-label REPLACES the content rather than adding to it.
//
// This used to be `r.name ?? r.id ?? 'row'`, which is correct for the tables
// whose rows carry one of those keys and silently useless for the ones that do
// not. Measured on 2026-08-27: Overview's subnet table rendered 150 rows with
// ONE distinct label between them, "View details for row", while Daily's table
// produced 30 distinct labels from the same code. The difference is that a
// subnet row keys its identity as `network`, so both branches missed and every
// row fell to the literal.
//
// So the fallback is the FIRST COLUMN'S OWN VALUE, which is the column a reader
// identifies the row by: it is why that column is first. Falling back to a
// hard-coded word is what produced 150 identical announcements, and no fixed
// list of key names would have caught `network` either.
function rowName(r, cols) {
  if (typeof r.rowLabel === 'string' && r.rowLabel !== '') return r.rowLabel
  // THE VISIBLE COLUMNS COME BEFORE r.name AND r.id, and that order is the
  // whole point rather than a detail.
  //
  // aria-label replaces what a row says with what we say about it, so the two
  // have to agree: a reader who hears a name and then looks for it must find
  // it on screen. r.name is often an INTERNAL identifier that the table never
  // paints. Measured while building this: the fixture's subnet rows carry
  // name="baseline-net-c" while the row displays "10.30.0.0", so preferring
  // r.name announced a string found nowhere in the row. The test caught it.
  //
  // So: the first scalar value across the visible columns, then the internal
  // keys as a last resort. Two shapes make "first column" alone wrong, and both
  // exist here: a leading action or checkbox column holds nothing for its own
  // key, and a `render` column can hold an object, which String() turns into
  // "[object Object]" — worse than the generic label it replaced, because it
  // looks deliberate. Scanning for the first usable value skips both.
  if (cols) {
    for (const c of cols) {
      if (c.hidden) continue
      const v = r[c.key]
      const t = typeof v
      if (v == null || v === '') continue
      if (t !== 'string' && t !== 'number' && t !== 'bigint') continue
      const str = String(v).trim()
      // An em dash is this app's "no value", so it identifies nothing.
      if (str === '' || str === '—' || str === '–') continue
      return str
    }
  }
  if (r.name != null && r.name !== '') return String(r.name)
  if (r.id != null && r.id !== '') return String(r.id)
  return 'row'
}

function colKind(c) {
  if (c.width) return 'fixed'
  if (c.render) return 'render'
  if (c.badge) return 'badge'
  if (c.mono) return 'mono'
  return 'text'
}

// Pick the grow column set: explicit `grow: true` columns, or (when none
// declare it) one implicit column so an all-hug table doesn't hug left and
// leave a dead gap on the right.
function pickGrowCols(cols) {
  const explicit = cols.filter((c) => c.grow)
  if (explicit.length) return explicit
  return [cols.find((c) => !c.badge && c.align !== 'right' && !c.mono) || cols[0]]
}

// ---------- DataTable ----------

/**
 * Shared inner-table primitive. Owns thead/tbody + scroll wrapper + auto-hide +
 * cap/clip + footer + optional sort. The <Card> shell stays in the caller.
 */
export function DataTable({
  rows,
  columns,
  limit,
  viewAllHref,
  maxHeight = 320,
  // Floor for the scroll box, for a panel that reserves its space before the
  // rows exist. Opt-in and undefined by default, so every existing caller keeps
  // a box that is exactly as tall as its content.
  //
  // A cap alone cannot hold a layout still. maxHeight pins the height only for
  // an estate with enough rows to overflow it; a shorter one renders shorter,
  // so a skeleton sized to the cap is then TALLER than the table that replaces
  // it and the panel collapses instead of growing. Same shift, other direction.
  // Passing both makes the box one height in every state that has a table in
  // it, which is the property a reserved space actually needs.
  minHeight,
  rowCap = 150,
  sort,
  onSort,
  rowKey,
  onRowClick,
  rowStyle,
  stickyHeader = true,
  emptyText = 'no data',
}) {
  const theme = useThemeColors()
  const fit = usePanelFit()
  const isControlled = typeof onSort === 'function'
  const [internalSort, setInternalSort] = useState(null)
  const activeSort = isControlled ? sort : internalSort

  const wrapperRef = useRef(null)
  const sansProbeRef = useRef(null)
  const monoProbeRef = useRef(null)
  const headProbeRef = useRef(null)
  const noteProbeRef = useRef(null)
  const widthProbeRef = useRef(null)
  const canvasCtxRef = useRef(null)
  const prevWidthsRef = useRef(null)
  const measureRef = useRef(null)
  const [colWidths, setColWidths] = useState(null)

  // 1. SORT FIRST (uncontrolled only; controlled caller already sorted `rows`).
  let sorted = rows
  if (!isControlled && activeSort && activeSort.key) {
    const col = columns.find((c) => c.key === activeSort.key)
    if (col) {
      sorted = [...rows].sort((a, b) => {
        let r
        if (col.comparator) r = col.comparator(a, b)
        else {
          const av = col.sortAccessor ? col.sortAccessor(a) : a[col.key]
          const bv = col.sortAccessor ? col.sortAccessor(b) : b[col.key]
          r = defaultCompare(av, bv)
        }
        return activeSort.dir === 'asc' ? r : -r
      })
    }
  }

  // 2. VISIBLE slice.
  const visible = limit != null ? sorted.slice(0, limit) : sorted.slice(0, rowCap)

  // 3 + 4. Auto-hide over full sorted rows.
  const cols = visibleColumns(columns, sorted)
  const growCols = pickGrowCols(cols)
  const isGrowCol = (c) => growCols.includes(c)

  function handleSort(key) {
    const next = toggleSort(activeSort, key)
    if (isControlled) onSort(next)
    else setInternalSort(next)
  }

  // ---- measurement ----
  // Canvas measureText for anything whose painted shape is known here (headers,
  // plain cells, pills). Offscreen layout for `render` columns ONLY, where the
  // caller's markup is arbitrary and reconstructing a width from text cannot
  // see its padding, borders, gaps or icons.

  function getCtx() {
    if (!canvasCtxRef.current) canvasCtxRef.current = document.createElement('canvas').getContext('2d')
    return canvasCtxRef.current
  }
  // `spacing` is CSS letter-spacing in px, and it has to be passed rather than
  // baked into `font`: the getComputedStyle().font SHORTHAND carries family,
  // size, weight, style and line-height and NOT letter-spacing or
  // text-transform. Both are on the header probe (tracking-wide, uppercase),
  // so measuring with the shorthand alone under-counts every header — measured
  // at 10.4px on "Status", which is what clipped it to "STAT…".
  //
  // ctx.letterSpacing is the exact thing (it is the same engine that paints),
  // so it is preferred and only falls back to arithmetic. The fallback adds one
  // gap per character INCLUDING the last, matching CSS, which puts a trailing
  // gap on the total exactly as the browser does.
  function textWidth(text, font, spacing = 0) {
    const ctx = getCtx()
    if (ctx.font !== font) ctx.font = font
    if ('letterSpacing' in ctx) {
      const want = `${spacing || 0}px`
      if (ctx.letterSpacing !== want) ctx.letterSpacing = want
      return ctx.measureText(text).width
    }
    return ctx.measureText(text).width + (spacing || 0) * text.length
  }
  function toPx(value) {
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.endsWith('px')) return parseFloat(value) || 0
    const probe = widthProbeRef.current
    if (probe) {
      probe.style.width = value
      return probe.getBoundingClientRect().width
    }
    return parseFloat(value) || 0
  }

  function measure() {
    const wrapper = wrapperRef.current
    if (!wrapper || !sansProbeRef.current || !monoProbeRef.current || !headProbeRef.current || !noteProbeRef.current) return null
    const sansFont = getComputedStyle(sansProbeRef.current).font
    const monoFont = getComputedStyle(monoProbeRef.current).font
    const noteFont = getComputedStyle(noteProbeRef.current).font
    // The header's transform and spacing are READ off the probe rather than
    // assumed, so restyling the probe restyles the measurement with it.
    const headStyle = getComputedStyle(headProbeRef.current)
    const headFont = headStyle.font
    const headSpacing = parseFloat(headStyle.letterSpacing) || 0
    const headUpper = headStyle.textTransform === 'uppercase'
    const zeroWidth = textWidth('0', sansFont) || 7

    const chCap = (maxCh) => Math.ceil(maxCh * zeroWidth + CELL_PAD + MEASURE_BUFFER)

    // The rendered <td> text for one column, taken from the DOM this pass is
    // measuring. Empty on the very first pass (nothing painted yet), which is
    // fine: the row set that triggers this effect paints on the next commit and
    // re-measures then.
    const bodyRows = wrapper.querySelectorAll('tbody tr')

    // The intrinsic width of a `render` column, taken by LAYING THE CELLS OUT
    // rather than by reconstructing a number from their text.
    //
    // Canvas measureText on td.textContent was the previous method and it is
    // wrong whenever the renderer emits anything but bare text. Measured on the
    // real app: 16 cells across 8 tabs paint an 11px pill inside a 14px cell,
    // and measuring their text at 14px over-stated those columns by 1–26px
    // each. Text width is also only part of a cell — a pill's own padding, a
    // border, a flex gap, an icon and multi-node content are all invisible to
    // measureText, and a renderer is free to vary all of them PER ROW, so
    // sampling one row cannot stand in for the column.
    //
    // Laying out sidesteps every one of those. The clones go in an absolutely
    // positioned max-content container, so the width that comes back is the
    // content's OWN width and not a function of the width the column already
    // has — which is the property that keeps this out of the measure-grow-
    // measure loop that ruled out scrollWidth. All rows are appended before any
    // is read, so this costs one layout flush per render column, not one per
    // row.
    //
    // THE STAGE IS A REAL <table>, and that is not decoration. A clone measured
    // in a plain <div> has left its table ancestry behind, so every rule written
    // as `table <x>` stops matching it. The live example: the coarse-pointer
    // touch rule gives controls a 44px floor and exempts `table input` from it,
    // so Security's and Incidents' Ack checkbox — a `render` column — measured
    // 13px in the table and 44px in a div, and the column would have been
    // inflated by 31px on every touch device. Codex found this on the diff.
    // Cloning into table > tbody > tr > td keeps those selectors matching.
    //
    // The td's own font is read once: it comes from `tdBase`, identical for
    // every row of a column. What varies row to row lives INSIDE the cell and
    // travels with the clone, carrying its own classes.
    const renderedNaturalWidth = (idx) => {
      if (idx < 0 || bodyRows.length === 0) return 0
      const firstTd = bodyRows[0].children[idx]
      if (!firstTd) return 0
      // The stage is BUILT AND TORN DOWN INSIDE THIS FUNCTION, never left in
      // the tree. A persistent hidden <table> was the first version and it was
      // wrong for a reason worth recording: every spec that scans the page with
      // querySelectorAll('table') suddenly found an extra one. It broke three
      // density assertions and the pill-width assertion in this repo alone.
      // Built here, it exists only within this synchronous block — measure()
      // never yields — so nothing outside can observe it, while the element is
      // attached and a real <table> for as long as the layout is read, which is
      // what keeps `table <x>` selectors matching the clones.
      const probe = document.createElement('table')
      probe.setAttribute('aria-hidden', 'true')
      Object.assign(probe.style, {
        position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
        left: '0', top: '0', width: 'max-content', tableLayout: 'auto',
        borderCollapse: 'collapse',
      })
      const tdStyle = getComputedStyle(firstTd)
      const rows = []
      const cells = []
      // Identical markup in identical context has identical intrinsic width, so
      // a column of 150 status pills drawn from four distinct values costs four
      // clones rather than 150. This is what keeps the worst case (rowCap rows
      // x several render columns) off the layout path; Codex raised the cost as
      // finding 2 on the diff and the fixtures are too small to have shown it.
      const seenMarkup = new Set()
      for (const tr of bodyRows) {
        const td = tr.children[idx]
        if (!td) continue
        const markup = td.innerHTML
        if (seenMarkup.has(markup)) continue
        seenMarkup.add(markup)
        const probeRow = document.createElement('tr')
        const probeCell = document.createElement('td')
        // Zero padding: CELL_PAD is added to the result by the caller, so the
        // stage must not contribute any of its own.
        probeCell.style.padding = '0'
        probeCell.style.border = '0'
        probeCell.style.whiteSpace = 'nowrap'
        // Text nodes sitting directly in the td inherit the td's font, which
        // the clone does not carry (those classes are on the td itself).
        probeCell.style.font = tdStyle.font
        probeCell.style.letterSpacing = tdStyle.letterSpacing
        for (const node of td.childNodes) probeCell.appendChild(node.cloneNode(true))
        probeRow.appendChild(probeCell)
        rows.push(probeRow)
        cells.push(probeCell)
      }
      if (cells.length === 0) return 0
      // An explicit tbody: appending <tr> straight to a <table> through the DOM
      // does not create one the way the HTML parser would, and leaves the rows
      // relying on CSS anonymous-box fixup.
      const tbody = document.createElement('tbody')
      tbody.append(...rows)
      probe.appendChild(tbody)
      // Attached inside the real table's own wrapper, so it inherits the same
      // cascade the live cells sit in.
      wrapper.appendChild(probe)
      let max = 0
      try {
        for (const c of cells) {
          const w = c.getBoundingClientRect().width
          if (w > max) max = w
        }
      } finally {
        probe.remove()
      }
      return max
    }

    const fixed = {}
    const naturals = {}
    for (const c of cols) {
      if (c.width) {
        fixed[c.key] = toPx(c.width)
        continue
      }
      const font = c.mono ? monoFont : sansFont
      const rawLabel = String(c.label ?? '')
      const paintedLabel = headUpper ? rawLabel.toUpperCase() : rawLabel
      let w = textWidth(paintedLabel, headFont, headSpacing) + (c.sortable ? SORT_AFFORDANCE_PAD : 0)
      // A `render` column is measured from the text on screen, read out of the
      // DOM; every other column from its raw value. The raw value is the WRONG
      // input for a render column and it was wrong in both directions:
      //
      //   Incidents "SOC Queue" — key 'action', which no row carries, renders
      //   r.title/r.name/r.message. The raw value is undefined, so the column
      //   was sized to its header label. Survivable while the panel's width was
      //   declared by hand; once the width FOLLOWS this number it collapsed the
      //   whole panel to a 197px sliver.
      //
      //   Infra "Jobs" — key 'created_at', renders fmtDate(v). The raw value is
      //   a 24-char ISO timestamp in a mono font (251px); "7/15/2026, 3:55:50
      //   PM" is 173px. The column was 78px wider than anything ever shown in
      //   it, which is dead space by construction.
      //
      // NOT scrollWidth: a rendered cell's scrollWidth is a function of the
      // width it was already given (its contents wrap), so feeding that back in
      // would be a measure-grow-measure loop. renderedNaturalWidth() above
      // reads the same cells laid out at max-content instead, which is the same
      // number however narrow the real column gets. Before the first paint
      // there is no DOM to read and the raw value stands in for one pass.
      const laidOut = c.render ? renderedNaturalWidth(cols.indexOf(c)) : 0
      if (laidOut > 0) {
        if (laidOut > w) w = laidOut
      } else {
        for (const r of visible) {
          const v = r[c.key]
          // A badge PAINTS its text at text-note inside a text-copy cell, so it
          // is measured with the note probe. Measuring it at 14px is what made
          // every pill column 1–26px wider than anything ever shown in it.
          const text = c.badge ? String(v || '—') : v != null ? String(v) : '—'
          const tw = textWidth(text, c.badge ? noteFont : font) + (c.badge ? BADGE_PAD : 0)
          if (tw > w) w = tw
        }
      }
      let natural = Math.ceil(w + CELL_PAD + MEASURE_BUFFER)
      if (c.maxCh) natural = Math.min(natural, chCap(c.maxCh))
      naturals[c.key] = natural
    }

    // Two priority tiers for shrinking below natural width, plus a dynamic
    // clip marker — this is what makes BOTH invariants hold even on a card too
    // narrow for its content, instead of one winning at the other's expense:
    //   Tier 1 (shrink first): maxCh/render columns (already opted into
    //   clipping) and non-mono grow columns (their content WRAPS via
    //   line-clamp-2 instead of clipping, so less width is always safe).
    //   Tier 2 (shrink only as a last resort): plain hug/mono/mono-grow
    //   columns. They're nowrap, so shrinking them below natural DOES clip —
    //   but a real card can be narrower than its natural content demands, and
    //   invariant 1 (never overflow, i.e. never silently lose data off-screen)
    //   outranks invariant 2 (don't clip without a marker). So if — and only
    //   if — tier 1 hits its floors and space is still short, tier 2 gives up
    //   width too, and any column actually narrowed below its own natural
    //   width gets an inline max-width marker (computed here, not declared by
    //   the caller) so the clip is visible/intentional rather than the silent
    //   equal-split bug this whole model exists to prevent.
    const capped = cols.filter((c) => !c.width && (c.maxCh || c.render))
    const growWrapSet = cols.filter((c) => !c.width && isGrowCol(c) && !c.mono && !c.maxCh && !c.render)
    const tier1 = [...capped, ...growWrapSet]
    const tier2 = cols.filter((c) => !c.width && !tier1.includes(c))

    const fixedTotal = Object.values(fixed).reduce((a, b) => a + b, 0)
    const available = wrapper.clientWidth
    const budget = Math.max(0, available - fixedTotal)
    const totalNatural = cols.reduce((a, c) => (c.width ? a : a + naturals[c.key]), 0)

    // Tell the enclosing Card how much width these columns actually need, so
    // the panel's GRID width can follow its content instead of a hand-declared
    // span. This number is deliberately independent of `available` — it is the
    // sum of the columns' natural widths — which is what makes the loop
    // impossible: a wider panel never asks for more room than a narrow one.
    if (fit) fit.report(fixedTotal + totalNatural)

    const floorFor = (c) => {
      const font = c.mono ? monoFont : sansFont
      const chW = textWidth('0', font) || zeroWidth
      return Math.min(SHRINK_FLOOR_MAX, Math.ceil(chW * SHRINK_FLOOR_CH + CELL_PAD))
    }

    // Proportional shrink: reduce `set` columns toward their floors,
    // widest-slack first, absorbing up to `excess` px. Returns how much was
    // actually absorbed (<= excess if every column hit its floor).
    function shrinkToward(set, cur, excess) {
      let remaining = excess
      let iterations = 0
      while (remaining > 0.5 && iterations < 10) {
        const slack = set.filter((c) => cur[c.key] > floorFor(c))
        if (slack.length === 0) break
        const totalSlack = slack.reduce((a, c) => a + (cur[c.key] - floorFor(c)), 0)
        if (totalSlack <= 0) break
        const reduceNow = Math.min(remaining, totalSlack)
        for (const c of slack) {
          const share = (cur[c.key] - floorFor(c)) / totalSlack
          cur[c.key] -= reduceNow * share
        }
        remaining -= reduceNow
        iterations++
      }
      return excess - remaining
    }

    const widths = { ...fixed }
    const clipMarked = {}
    const cur = {}
    for (const c of cols) if (!c.width) cur[c.key] = naturals[c.key]

    if (totalNatural <= budget) {
      // Fits: leftover width is split equally across the non-mono grow
      // columns; maxCh/render columns stay at their natural width instead of
      // growing past the limit they (or their opaque markup) implied.
      const leftover = budget - totalNatural
      const share = growWrapSet.length ? leftover / growWrapSet.length : 0
      for (const c of growWrapSet) cur[c.key] += share
    } else {
      // Doesn't fit: shrink tier 1 first; only reach into tier 2 (hug/mono,
      // normally protected) if tier 1's floors still leave a deficit.
      let excess = totalNatural - budget
      excess -= shrinkToward(tier1, cur, excess)
      if (excess > 0.5) shrinkToward(tier2, cur, excess)
    }

    // ROUNDING IS SHARED, NOT PER-COLUMN, AND THAT IS THE WHOLE POINT.
    //
    // `cur` holds fractional widths that add up to `budget` exactly. Rounding
    // each column on its own — which this did until 2026-08-10 — throws that
    // away: five independent Math.rounds can each gain up to half a pixel, so
    // the total lands anywhere within ±n/2 of the budget. When it lands high
    // the table is wider than the wrapper, and because the wrapper is
    // `overflow-x-hidden` the surplus is not a scrollbar the reader can use, it
    // is a silently clipped column edge.
    //
    // Measured on the Assets tab (50 stub rows, 5 columns), sweeping every
    // viewport width from 760 to 1600: seven widths overflowed by exactly 1px —
    // 767, 806, 926, 931, 960, 990, 1000. At 806 the columns came out
    // 187+144+128+115+147 = 721 against a 720px budget. At the 834 widths that
    // did not overflow the same arithmetic simply happened to round down.
    //
    // The fix is the largest-remainder method: floor every column, then hand
    // the leftover pixels back one each to the columns with the biggest
    // fractional parts. The sum is then the budget by construction rather than
    // by luck, which is what the `table-fixed` comment above already claimed.
    const flexible = cols.filter((c) => !c.width)
    // Never ask for more than the budget. In the doesn't-fit branch above,
    // `cur` can still total MORE than the budget when every column has hit its
    // shrink floor — a card genuinely too narrow for its content. Clamping here
    // keeps that case exactly as it was (the floors win, the table overflows
    // because there is no other honest answer) instead of letting this rounding
    // pass quietly widen it further.
    const curTotal = flexible.reduce((a, c) => a + cur[c.key], 0)
    const target = Math.min(budget, Math.round(curTotal))

    let floorSum = 0
    for (const c of flexible) {
      widths[c.key] = Math.max(1, Math.floor(cur[c.key]))
      floorSum += widths[c.key]
    }

    // Biggest fractional part gets the first spare pixel — the column that was
    // closest to deserving it. Ties break on the declared column order, which
    // is stable across re-measures, so a resize does not shuffle which column
    // carries the odd pixel.
    let spare = target - floorSum
    if (spare > 0) {
      const byRemainder = flexible
        .map((c, i) => ({ c, i, frac: cur[c.key] - Math.floor(cur[c.key]) }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i)
      for (let n = 0; spare > 0 && n < byRemainder.length; n++, spare--) {
        widths[byRemainder[n].c.key] += 1
      }
    } else if (spare < 0) {
      // Only reachable when Math.max(1, …) above floored a column up to 1px.
      // Take the debt off the widest columns, never below 1px.
      const byWidth = flexible
        .map((c, i) => ({ c, i }))
        .sort((a, b) => widths[b.c.key] - widths[a.c.key] || a.i - b.i)
      for (let n = 0; spare < 0 && n < byWidth.length; n++) {
        const k = byWidth[n].c.key
        if (widths[k] > 1) { widths[k] -= 1; spare++ }
      }
    }

    for (const c of flexible) {
      // maxCh/render are always marked (their own ceiling, or opaque markup
      // that may self-clip regardless of width); tier 2 columns are marked
      // only when they actually had to give up width below their natural
      // size — growWrap columns never clip horizontally (they wrap) so they
      // never need the marker.
      if (c.maxCh || c.render) clipMarked[c.key] = true
      else if (tier2.includes(c) && widths[c.key] < naturals[c.key]) clipMarked[c.key] = true
    }

    return { widths, clipMarked }
  }

  measureRef.current = measure

  // Recompute whenever the rendered rows or the visible column set change
  // (both are fresh arrays each such render, so this also naturally re-fires
  // if row content or column defs change without the array identity changing
  // across renders driven by the same data). Guarded by widthsEqual so an
  // unchanged measurement never re-sets state — that guard is what stops this
  // from looping, not the dependency list. useLayoutEffect (not useEffect) so
  // the fixed-width pass lands before the browser paints, avoiding a visible
  // table-auto -> table-fixed flicker.
  useLayoutEffect(() => {
    const w = measureRef.current()
    if (w && !widthsEqual(w, prevWidthsRef.current)) {
      prevWidthsRef.current = w
      setColWidths(w)
    }
  }, [cols, visible])

  // Recompute on wrapper resize (sidebar toggle, viewport change, etc.) — this
  // is layout the render pass above can't see. rAF-debounced so a resize storm
  // coalesces into one measurement, and it's safe from feedback: the wrapper's
  // width comes from its PARENT layout, and our table can never exceed the
  // wrapper (that's the whole point), so setting column widths cannot itself
  // resize the wrapper and re-trigger the observer.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || typeof ResizeObserver === 'undefined') return undefined
    let raf = null
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const w = measureRef.current()
        if (w && !widthsEqual(w, prevWidthsRef.current)) {
          prevWidthsRef.current = w
          setColWidths(w)
        }
      })
    })
    ro.observe(wrapper)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  if (rows.length === 0) {
    return <div className="min-h-[100px] flex items-center justify-center text-muted text-copy">{emptyText}</div>
  }

  const headBg = stickyHeader ? 'sticky top-0 z-10 bg-card' : ''
  // Before the first measurement lands, fall back to table-auto so we never
  // render with the old equal-split table-fixed bug; once colWidths exists,
  // table-fixed + explicit px widths make overflow arithmetically impossible.
  const tableLayoutClass = colWidths ? 'table-fixed' : 'table-auto'

  function cellStyle(c) {
    if (!colWidths) return undefined
    const w = `${colWidths.widths[c.key]}px`
    // The inline max-width is the visible, testable marker that this column
    // may clip: maxCh/render columns are always marked (an explicit ceiling,
    // or opaque markup DataTable can't promise never clips); any other
    // column is marked only when the allocator actually had to narrow it
    // below its measured natural width (computed in measure(), not declared
    // by the caller) — that's what keeps a plain hug/mono column from ever
    // clipping SILENTLY, while still letting it give up space as a last
    // resort so the table never overflows its wrapper.
    return colWidths.clipMarked[c.key] ? { width: w, maxWidth: w } : { width: w }
  }

  const table = (
    <table className={`w-full ${tableLayoutClass} border-collapse text-copy`}>
      <thead>
        <tr>
          {cols.map((c) => {
            const alignRight = c.align === 'right'
            const lowPri = c.priority === 'low' ? ' @max-[360px]:hidden' : ''
            // py-[var(--sp-cell-y)] is density-driven; px-2.5 is NOT, and must
            // never become so — CELL_PAD above hard-codes it for the canvas
            // measurer, so a density that moved it would desync the two.
            const base = `${headBg} text-note font-medium text-dim uppercase tracking-wide py-[var(--sp-cell-y)] px-2.5 border-b border-line-2 overflow-hidden text-ellipsis ${alignRight ? 'text-right' : 'text-left'}${lowPri}`
            if (c.sortable) {
              const isActive = activeSort && activeSort.key === c.key
              const ariaSort = isActive ? (activeSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
              return (
                <th key={c.key} aria-sort={ariaSort} data-col-kind={colKind(c)} className={base} style={cellStyle(c)}>
                  <button
                    type="button"
                    onClick={() => handleSort(c.key)}
                    className={`inline-flex items-center gap-1 uppercase tracking-wide select-none cursor-pointer hover:text-muted ${alignRight ? 'flex-row-reverse' : ''}`}
                  >
                    {c.label}
                    <span aria-hidden="true">{isActive ? (activeSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                  </button>
                </th>
              )
            }
            return (
              <th key={c.key} data-col-kind={colKind(c)} className={base} style={cellStyle(c)}>
                {c.label}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {visible.map((r, i) => (
          <tr
            key={rowKey ? rowKey(r, i) : `${r.id ?? r.name ?? r.created_at ?? ''}|${i}`}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onKeyDown={
              onRowClick
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onRowClick(r)
                    }
                  }
                : undefined
            }
            tabIndex={onRowClick ? 0 : undefined}
            role={onRowClick ? 'button' : undefined}
            aria-label={onRowClick ? `View details for ${rowName(r, cols)}` : undefined}
            style={rowStyle ? rowStyle(r) : undefined}
            className={
              onRowClick
                ? 'cursor-pointer hover:bg-line/50 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset'
                : undefined
            }
          >
            {cols.map((c) => {
              const v = r[c.key]
              const alignRight = c.align === 'right'
              const lowPri = c.priority === 'low' ? ' @max-[360px]:hidden' : ''
              const tdBase = `py-[var(--sp-cell-y)] px-2.5 border-b border-line overflow-hidden ${alignRight ? 'text-right' : ''}${lowPri}`
              // 5. render -> badge -> mono -> default text.
              if (c.render) {
                return (
                  <td key={c.key} className={tdBase} style={cellStyle(c)}>
                    {c.render(v, r)}
                  </td>
                )
              }
              if (c.badge) {
                const st = statusBadgeColor(v) || { bg: theme.pillNeutralBg, fg: theme.pillNeutralFg }
                return (
                  <td key={c.key} className={tdBase} style={cellStyle(c)}>
                    <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: st.bg, color: st.fg }}>
                      {v || '—'}
                    </span>
                  </td>
                )
              }
              if (c.mono) {
                return (
                  <td key={c.key} className={tdBase} style={cellStyle(c)}>
                    <span
                      className="block overflow-hidden whitespace-nowrap text-ellipsis font-mono"
                      title={v != null ? String(v) : undefined}
                    >
                      {v ?? '—'}
                    </span>
                  </td>
                )
              }
              // hug columns stay single-line (nowrap+ellipsis); the grow
              // column(s) hold the spare width, so non-mono grow cells wrap up
              // to 2 lines instead of truncating the column that can afford to
              // show more. mono still favors single-line — wrapping an
              // FQDN/SKU/IP mid-string hurts readability more than it helps.
              // break-words matters here: a grow column can be shrunk under
              // pressure (it's in the opted-in-to-clip pool), and an unbroken
              // token (an opaque id with no spaces) won't wrap on its own —
              // without a mid-word break it overflows horizontally instead of
              // clipping vertically via line-clamp, which is the one thing a
              // grow column is never supposed to do.
              const wrapClass = isGrowCol(c) ? 'line-clamp-2 break-words' : 'whitespace-nowrap text-ellipsis'
              return (
                <td key={c.key} className={tdBase} style={cellStyle(c)}>
                  <span className={`block overflow-hidden ${wrapClass}`} title={v != null ? String(v) : undefined}>
                    {v ?? '—'}
                  </span>
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )

  // 8. Footer.
  let footer = null
  if (limit != null && viewAllHref && rows.length > limit) {
    footer = (
      <a
        href={viewAllHref}
        className="block text-center text-link text-note font-medium py-2 px-2.5 hover:bg-line/50 rounded-control transition-colors"
      >
        View all {rows.length} →
      </a>
    )
  } else if (limit == null && rows.length > rowCap) {
    footer = (
      <div className="text-center text-dim text-note py-2">
        showing {rowCap} of {rows.length.toLocaleString()} — filter to narrow
      </div>
    )
  }

  // Explicit px widths (table-fixed) that sum to <= the wrapper's clientWidth
  // make overflow arithmetically impossible, so the wrapper never x-scrolls
  // (the user's #1 complaint). @container only hides priority:'low' columns at
  // true phone width (<360px). Long values clip within their column via
  // ellipsis (or a 2-line clamp for the non-mono grow column).
  return (
    <div className="@container">
      {/* Hidden font probes: getComputedStyle on a real (offscreen) node gives
          the true rendered font for canvas measureText — display:none would
          still resolve font metrics, but visibility:hidden also lets the width
          probe below report real layout widths for CSS length -> px conversion. */}
      <span ref={sansProbeRef} className="text-copy" style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none' }} />
      <span ref={monoProbeRef} className="text-copy font-mono" style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none' }} />
      <span
        ref={headProbeRef}
        className="text-note font-medium uppercase tracking-wide"
        style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none' }}
      />
      {/* The pill probe. Badge cells paint their text at text-note inside a
          text-copy cell, so measuring them needs the note font, not the body
          font. font-medium matches the pill span's own weight. */}
      <span ref={noteProbeRef} className="text-note font-medium" style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none' }} />
      <span ref={widthProbeRef} style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none' }} />
      <div ref={wrapperRef} className="overflow-x-hidden overflow-y-auto" style={{ maxHeight, minHeight }}>
        {table}
      </div>
      {footer}
    </div>
  )
}

// ---------- FeedCard (thin Card + gates + DataTable) ----------

export function FeedCard({ span, panelId, title, note, feed, columns, limit, viewAllHref, count }) {
  const rows = feed.data?.rows ?? []
  const bad = feed.error || feed.data?.status === 'error'
  // "500" and "500 of 532" are different claims. feedCountLabel only makes the
  // second one when the server said the list was truncated AND handed over a
  // total that is actually larger — see ui/src/lib/feedCount.js.
  const countLabel = count ? feedCountLabel(feed.data, rows.length) : null
  const right = countLabel ? (
    <span className="text-note text-muted" title={feedCountTitle(feed.data, rows.length)}>{countLabel}</span>
  ) : undefined

  return (
    <Card span={span} panelId={panelId} title={title} note={note} right={right}>
      {feed.loading && !feed.data ? (
        <Skeleton h={160} />
      ) : bad ? (
        <Empty>feed unavailable</Empty>
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <DataTable rows={rows} columns={columns} limit={limit} viewAllHref={viewAllHref} />
      )}
    </Card>
  )
}
