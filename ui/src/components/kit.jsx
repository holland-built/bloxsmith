// Shared pieces of the page chrome: status pills, the row of headline number
// tiles, and the breadcrumb bar.
//
// Colours come only from tokens in index.css, so both themes and the contrast
// tests cover them. Red means critical, amber means warning and green means
// healthy, the same meaning the charts already use.
import { useEffect, useRef, useState } from 'react'
import { FOCUS_RING } from './ui.jsx'

const TONE = {
  crit: { bg: 'var(--pill-crit-bg)', fg: 'var(--pill-crit-fg)', dot: 'var(--color-crit)' },
  warn: { bg: 'var(--pill-warn-bg)', fg: 'var(--pill-warn-fg)', dot: 'var(--color-warn)' },
  ok: { bg: 'var(--pill-ok-bg)', fg: 'var(--pill-ok-fg)', dot: 'var(--color-ok)' },
  neutral: { bg: 'var(--pill-neutral-bg)', fg: 'var(--pill-neutral-fg)', dot: 'var(--color-other)' },
}

export function StatusPill({ tone = 'neutral', children }) {
  const t = TONE[tone] || TONE.neutral
  return (
    <span className="inline-block rounded-mark px-2 py-0.5 text-note font-semibold whitespace-nowrap" style={{ background: t.bg, color: t.fg }}>
      {children}
    </span>
  )
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
// Scroll to a panel and move focus to it. A panel taken off the page has no
// element, so focus goes to Arrange panels, where it can be put back.
function jumpToPanel(panelId) {
  const el = document.querySelector(`[data-panel-id="${panelId}"]`)
  if (!el) {
    const arrange = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Arrange panels')
    arrange?.focus()
    return
  }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
}

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
  6: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-6',
}
const TILE_COLS_DEFAULT = 'grid-cols-2 md:grid-cols-4 xl:grid-cols-6'

export function HeadlineStrip({ items, label }) {
  return (
    <ul aria-label={label} className={`grid gap-[var(--sp-grid-gap)] mb-[var(--sp-grid-gap)] ${TILE_COLS[items.length] || TILE_COLS_DEFAULT}`}>
      {items.map((it) => {
        const tone = it.value != null && TONE[it.tone] && it.tone !== 'neutral' ? it.tone : null
        const style = tone
          ? {
              background: `color-mix(in srgb, ${TONE[tone].dot} 14%, var(--color-card))`,
              borderColor: `color-mix(in srgb, ${TONE[tone].dot} 40%, var(--color-card-border))`,
            }
          : undefined
        const cls = `${TILE} ${tone ? 'hover:brightness-110' : 'bg-card border-card-border hover:bg-line'} ${FOCUS_RING}`
        const body = (
          <>
            <span className="text-note text-muted">{it.label}</span>
            <span className="text-figure font-semibold tabular-nums mt-1" style={tone ? { color: TONE[tone].dot } : undefined}>
              {it.value == null ? '—' : it.value}
              {it.unit ? <span className="text-note font-normal text-muted"> {it.unit}</span> : null}
            </span>
            {it.note ? <span className="text-note text-muted mt-auto pt-1">{it.note}</span> : null}
          </>
        )
        return (
          <li key={it.label} className="min-w-0">
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
