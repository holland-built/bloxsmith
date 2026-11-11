// Shared pieces of the page chrome: the row of headline number tiles and the
// breadcrumb bar.
//
// Colours come only from tokens in index.css, so both themes and the contrast
// tests cover them. Red means critical, amber means warning and green means
// healthy, the same meaning the charts already use.
import { useEffect, useRef, useState } from 'react'
import { FOCUS_RING } from './ui.jsx'
import { jumpToPanel } from '../lib/jumpToPanel.js'

const TONE = {
  crit: { dot: 'var(--color-crit)' },
  warn: { dot: 'var(--color-warn)' },
  ok: { dot: 'var(--color-ok)' },
  neutral: { dot: 'var(--color-other)' },
}

// The headline numbers across the top of a page, one tile each. A tile jumps
// to the panel about it (scrolls it into view and moves focus there), or, when
// the detail lives on another tab, is a link to that tab. A value that is null
// was not measured and shows a dash, never a zero.
//
// A tile that reports a state says so twice: the figure takes the state's
// colour and the tile is tinted with it. The label carries the meaning in
// words ("Hosts offline"), so the colour is never the only signal, and a tile
// whose value is unknown takes no tone at all: a dash is not good news.
// min-h is the height of a tile holding all three lines (label, figure, note)
// plus its border, so a tile with a dash and no note is already that box.
// tests/overview-cls.spec.ts measures it.
const TILE = 'w-full h-full min-h-[88px] flex flex-col text-left px-3 pt-2.5 pb-2 rounded-surface border no-underline text-txt cursor-pointer'

// Columns by how many tiles there are, so every row of tiles is a full row at
// every width: six go 2, 3, then 6 across; four go 2 then 4; two share the row.
// Written out in full because Tailwind only emits classes it can read as whole
// strings.
//
// Two had no entry until 2026-10-04 and fell through to the default below, so
// Assets, the one page with two tiles, drew them in a four- and then a
// six-column row and left the rest of it empty.
const TILE_COLS = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-4',
  5: 'grid-cols-2 md:grid-cols-5',
  6: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-6',
}
const TILE_COLS_DEFAULT = 'grid-cols-2 md:grid-cols-4 xl:grid-cols-6'

export function HeadlineStrip({ items, label }) {
  return (
    <ul aria-label={label} className={`grid gap-[var(--sp-grid-gap)] mb-[var(--sp-grid-gap)] ${TILE_COLS[items.length] || TILE_COLS_DEFAULT}`}>
      {items.map((it, i) => {
        const tone = it.value != null && TONE[it.tone] && it.tone !== 'neutral' ? it.tone : null
        // Only a tile that needs action is tinted. "ok" keeps its data-tone
        // but stays plain, so good news never competes with a red tile.
        const fill = tone && tone !== 'ok' ? tone : null
        const style = fill
          ? {
              background: `color-mix(in srgb, ${TONE[fill].dot} 14%, var(--color-card))`,
              borderColor: `color-mix(in srgb, ${TONE[fill].dot} 40%, var(--color-card-border))`,
            }
          : undefined
        const cls = `${TILE} ${fill ? 'hover:brightness-110' : 'bg-card border-card-border hover:bg-line'} ${FOCUS_RING}`
        const body = (
          <>
            <span className="text-note text-muted">{it.label}</span>
            <span className="text-figure font-semibold tabular-nums mt-1" style={fill ? { color: TONE[fill].dot } : undefined}>
              {it.value == null ? (it.loading ? <span className="text-copy font-normal text-muted">Loading…</span> : '—') : it.value}
              {it.unit ? <span className="text-note font-normal text-muted"> {it.unit}</span> : null}
            </span>
            {it.note ? <span className="text-note text-muted mt-auto pt-1">{it.note}</span> : null}
          </>
        )
        return (
          // Five tiles in two columns leave the last one alone in its row, so
          // it takes the whole row until the strip goes to five columns.
          <li key={it.label} className={`min-w-0${items.length === 5 && i === 4 ? ' col-span-2 md:col-span-1' : ''}`}>
            {it.href ? (
              <a href={it.href} data-tone={tone || undefined} className={cls} style={style}>{body}</a>
            ) : (
              <button type="button" data-tone={tone || undefined} onClick={() => jumpToPanel(it.panelId)} className={cls} style={style}>{body}</button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// The bar under the top bar: where you are, and this page's actions.
export function PageBar({ group, page, children }) {
  return (
    <div className="flex items-center justify-between gap-3 px-6 py-2 border-b border-line bg-card">
      <nav aria-label="Breadcrumb" className="text-copy">
        <ol className="flex items-center gap-2">
          <li className="text-muted">{group}</li>
          <li aria-hidden="true" className="text-dim">›</li>
          <li aria-current="page" className="font-semibold">{page}</li>
        </ol>
      </nav>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

// The Change tabs' task rail: a list of the panels on the page, beside them,
// each jumping to its panel. It reads the panels off the page itself, so it
// follows Provision's mode switch, a Drift result appearing, and a panel taken
// off with Arrange panels, with nothing to keep in step by hand. The panel in
// view is marked. Below lg there is no room beside the forms, so it is not
// shown and the page is exactly what it was.
export function PageRail({ children }) {
  const ref = useRef(null)
  const [items, setItems] = useState([])
  const [active, setActive] = useState(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const read = () => {
      const next = [...root.querySelectorAll('[data-card-grid] [data-panel-id]')].map((el) => ({
        id: el.getAttribute('data-panel-id'),
        title: el.querySelector('h2')?.textContent.trim() || el.getAttribute('data-panel-id'),
      }))
      setItems((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    // Only a panel arriving or leaving, or a panel title changing, can change
    // the list. Provision streams every log line into the page, so re-reading
    // on each one would rescan an ever-longer log once per line.
    const isPanel = (n) => n.nodeType === 1 && (n.matches('[data-panel-id], [data-card-grid]') || n.querySelector('[data-panel-id]'))
    const inTitle = (n) => !!(n.nodeType === 1 ? n : n.parentElement)?.closest('[data-panel-id] h2')
    const relevant = (r) => inTitle(r.target) || [...r.addedNodes, ...r.removedNodes].some(isPanel)
    read()
    const mo = new MutationObserver((records) => { if (records.some(relevant)) read() })
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    if (!items.length || typeof IntersectionObserver === 'undefined') return
    const seen = new Map()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.getAttribute('data-panel-id'), e.isIntersecting)
      setActive(items.find((it) => seen.get(it.id))?.id ?? null)
    })
    for (const it of items) {
      const el = document.querySelector(`[data-panel-id="${it.id}"]`)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [items])

  return (
    <div ref={ref} className="lg:flex lg:items-start lg:gap-6">
      <nav aria-label="On this page" className="hidden lg:block sticky top-16 w-[200px] flex-none pt-5 pl-6">
        <p className="text-copy font-semibold text-txt mb-2">On this page</p>
        <ul>
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                onClick={() => jumpToPanel(it.id)}
                aria-current={active === it.id ? 'location' : undefined}
                className={`block w-full text-left text-copy py-1 pl-3 border-l ${active === it.id ? 'border-txt text-txt' : 'border-border text-muted hover:text-txt'} ${FOCUS_RING}`}
              >
                {it.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** One line saying the tenant is read-only and what still works. */
export function ReadOnlyNote({ ro, what }) {
  if (!ro.readOnly) return null
  return (
    <p data-read-only-note="" role="status" className="text-note text-warn mb-2">
      {ro.name} is read-only. {what} An admin can switch it to read-write in Settings.
    </p>
  )
}

// A form page: the inputs on the left, what they produce on the right, so the
// result appears beside the button that made it instead of under a wall of
// panels. Anything wide, such as a history list, goes below both. Below lg the
// two stack, form first.
export function FormColumns({ form, result, below, cols = 'lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)]' }) {
  return (
    <>
      <div className={`grid grid-cols-1 ${cols} gap-6 items-start`}>
        <div className="min-w-0">{form}</div>
        <div className="min-w-0" data-result-column="">{result}</div>
      </div>
      {below && <div className="mt-8">{below}</div>}
    </>
  )
}

// The heading over each column of a form page.
export function ColumnHeading({ id, children }) {
  return <h2 id={id} className="text-copy font-semibold mb-3">{children}</h2>
}
