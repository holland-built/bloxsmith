import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  AreaChart, Area, BarChart, Bar, Cell, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useThemeColors } from '../lib/theme.jsx'

// Static COLORS as CSS var() strings: fine for inline HTML styles (auto-flip with
// theme), NOT for Recharts SVG props/gradients — chart code uses useChartTheme()
// which resolves real hex per theme.
export const COLORS = {
  accent: 'var(--color-accent)', purple: 'var(--color-purple)', warn: 'var(--color-warn)',
  crit: 'var(--color-crit)', ok: 'var(--color-ok)', other: 'var(--color-other)',
}

export function useChartTheme() {
  const colors = useThemeColors()
  return {
    COLORS: {
      accent: colors.accent,
      purple: colors.purple,
      warn: colors.warn,
      crit: colors.crit,
      ok: colors.ok,
      other: colors.other,
      sevHigh: colors.sevHigh,
    },
    TT: {
      contentStyle: { background: colors.field, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 12 },
      labelStyle: { color: colors.muted },
      itemStyle: { color: colors.txt },
    },
  }
}



// ---------- shared bits ----------
//
// CONTENT-DRIVEN PANEL WIDTH.
//
// Every Card used to declare its grid width by hand (`span={3}`), and that
// number had nothing to do with how much width the panel's content needed.
// Measured across all eight table tabs at 1024/1280/1600/1920 before this
// change, that produced both failure modes at once, on the same screen:
//
//   Overview "Top Subnets by Utilization"  span 6, needs 389px  -> 1445px dead
//   Daily    "DNS Zone Issues"             span 6, needs 392px  -> 1442px dead
//   Infra    "Host Inventory"              span 6, needs 583px  -> 1251px dead
//   Incidents "SOC Queue"                  span 2, needs 708px  -> 365px given
//   Infra    "On-Prem Hosts"               span 2, needs 678px  -> 365px given
//
// It also made the layout non-monotonic: `span={4}` maps to 4-of-4 tracks below
// xl and 4-of-6 above it, so widening the window from 1024 to 1280 made the
// Audit Log panel NARROWER (976px -> 817px) and started clipping it.
//
// So the fix is here, not in DataTable — that component measures its columns
// correctly and is only ever told the wrong width to fit them into.
//
// HOW IT WORKS. A panel whose body can measure itself (DataTable) reports the
// pixel width its columns actually need. Card adds its own padding/border plus
// what its header needs, and registers that with the enclosing CardGrid, which
// gives it the fewest whole tracks that cover it.
//
// Panels that never report (charts, KPI stacks, forms) keep their declared span
// untouched, so this change cannot move a non-table panel.
//
// NO FEEDBACK LOOP. The reported number is the content's NATURAL width, which
// does not depend on how much width the panel was given — so widening a panel
// cannot change what it asks for. Track width comes from the grid, which is
// sized by the viewport, not by its children.
//
// The declared `span` stays as the pre-measurement fallback: before the first
// measurement lands, the layout is exactly what it was before this change.

const GridFitContext = createContext(null)

// applyLayout writes an explicit grid-column span onto each direct child of the
// grid. It runs against the DOM rather than React children on purpose: a couple
// of callers wrap their <Card> in a plain <div> that carries the span class, so
// the grid ITEM is not always the Card element (Network.jsx's DHCP Leases card
// is the live example). Walking the grid's own children is the only way to
// address the real grid items in every case.
function applyLayout(grid, items) {
  const gs = getComputedStyle(grid)
  const tracks = gs.gridTemplateColumns.split(' ').filter(Boolean)
  const trackCount = tracks.length
  const track = parseFloat(tracks[0])
  const gap = parseFloat(gs.columnGap) || 0
  if (!trackCount || !(track > 0)) return

  // Width of a span-s item: s tracks plus the (s-1) gaps it swallows.
  const widthOf = (s) => s * track + (s - 1) * gap
  const spanFor = (px) => {
    let s = 1
    while (s < trackCount && widthOf(s) < px) s++
    return s
  }

  // A measuring panel gets the fewest tracks that cover its content, and never
  // one more. Panels that do not measure are not touched at all, so their own
  // responsive span classes keep working.
  //
  // SQUARING OFF THE ROWS WAS BUILT FIRST AND MEASURED WORSE. Handing each
  // row's leftover tracks to whichever panel in it was furthest from fitting
  // does remove the ragged right edge, but across the eight table tabs at
  // 1024/1280/1600/1920 the totals came out:
  //
  //                       dead px INSIDE panels   ragged row edges   total
  //   hand-declared spans          37,447              20,168        57,615
  //   squared-off rows             25,598              21,029        46,627
  //   this (never stretch)         16,069              30,432        46,501
  //
  // Same total either way — it only decides whether the dead space sits at the
  // edge of a row or back inside a panel, and inside a panel is the thing being
  // complained about. Screenshots agreed: squaring off gave Host Health and
  // On-Prem Hosts their wide empty middles straight back.
  for (const el of Array.from(grid.children)) {
    const entry = items.get(el)
    if (!entry || entry.need == null) continue
    const span = spanFor(entry.need)
    const next = `span ${span} / span ${span}`
    if (el.style.gridColumn !== next) el.style.gridColumn = next
  }
}

export function CardGrid({ className = '', children }) {
  const ref = useRef(null)
  const itemsRef = useRef(new Map())
  const rafRef = useRef(null)

  const schedule = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (ref.current) applyLayout(ref.current, itemsRef.current)
    })
  }, [])

  const ctx = useMemo(
    () => ({
      gridRef: ref,
      set(itemEl, entry) {
        const prev = itemsRef.current.get(itemEl)
        if (prev && prev.need === entry.need && prev.declared === entry.declared) return
        itemsRef.current.set(itemEl, entry)
        schedule()
      },
      remove(itemEl) {
        if (itemsRef.current.delete(itemEl)) schedule()
      },
    }),
    [schedule],
  )

  // The grid's own width changes at every breakpoint and on a window resize;
  // the track width that pixels are converted against changes with it.
  useEffect(() => {
    const grid = ref.current
    if (!grid || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(schedule)
    ro.observe(grid)
    return () => ro.disconnect()
  }, [schedule])

  return (
    <GridFitContext.Provider value={ctx}>
      <div ref={ref} data-card-grid="" className={`grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 ${className}`}>
        {children}
      </div>
    </GridFitContext.Provider>
  )
}

const SPAN_CLASS = {
  1: 'col-span-1',
  2: 'col-span-2 md:col-span-2 xl:col-span-2',
  3: 'col-span-2 md:col-span-2 xl:col-span-3',
  4: 'col-span-2 md:col-span-4 xl:col-span-4',
  5: 'col-span-2 md:col-span-4 xl:col-span-5',
  6: 'col-span-2 md:col-span-4 xl:col-span-6',
}

// PanelFitContext is how a self-measuring body (DataTable) tells its Card how
// much width its content actually needs. A body that does not measure simply
// never calls it, and the Card keeps its declared span.
const PanelFitContext = createContext(null)

export function usePanelFit() {
  return useContext(PanelFitContext)
}

export function Card({ title, note, right, span = 2, className = '', innerRef, children }) {
  const spanClass = SPAN_CLASS[span] || SPAN_CLASS[6]
  const ref = useRef(null)
  const headRef = useRef(null)
  const titleRef = useRef(null)
  const noteRef = useRef(null)
  const rightRef = useRef(null)
  const headCanvasRef = useRef(null)
  const bodyNeedRef = useRef(null)
  const grid = useContext(GridFitContext)

  // The grid item is this Card, unless a caller wrapped it in a div that
  // carries the span class — then it is that wrapper. Resolved from the DOM so
  // both shapes work without every call site having to change.
  const gridItem = useCallback(() => {
    const el = ref.current
    const gridEl = grid?.gridRef?.current
    if (!el || !gridEl) return null
    let node = el
    while (node && node.parentElement !== gridEl) node = node.parentElement
    return node
  }, [grid])

  // A floor under the panel's width: the title on one line, plus whatever
  // controls sit in `right` (a filter box, a search field, a count).
  //
  // The title is measured with a canvas, not from the DOM. Two earlier attempts
  // both failed for the same underlying reason — a DOM width that is itself a
  // function of the width being decided:
  //
  //   1. Summing head.children caught the `flex-1` spacer, whose scrollWidth is
  //      its stretched RENDERED width. Panel grows -> spacer grows -> panel
  //      grows. Every measured panel ratcheted to a full-width span.
  //   2. Forcing the title to `truncate` made scrollWidth width-independent and
  //      fixed the loop, but nowrap then broke wrapping titles: "Asset
  //      Discovery" rendered as "Asset Di…" where it used to wrap onto two
  //      lines.
  //
  // Measuring the text itself is independent of any width, so the title can go
  // back to wrapping. `right` is shrink-0, so its width is intrinsic and safe
  // to read directly. The `note` is deliberately NOT in the floor: it is
  // secondary text that reads fine wrapped, and including it would widen every
  // panel that carries one.
  const headNeed = useCallback(() => {
    const head = headRef.current
    const titleEl = titleRef.current
    if (!head || !titleEl) return 0
    if (!headCanvasRef.current) headCanvasRef.current = document.createElement('canvas').getContext('2d')
    const ctx = headCanvasRef.current
    ctx.font = getComputedStyle(titleEl).font
    let sum = Math.ceil(ctx.measureText(titleEl.textContent || '').width)
    if (rightRef.current) {
      sum += (parseFloat(getComputedStyle(head).columnGap) || 0) + rightRef.current.scrollWidth
    }
    return sum
  }, [])

  const publish = useCallback(() => {
    const el = ref.current
    const item = gridItem()
    if (!el || !item || !grid) return
    const bodyNeed = bodyNeedRef.current
    if (bodyNeed == null) return
    const cs = getComputedStyle(el)
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
    // Everything between the grid item's outer edge and this card's content box:
    // the card's own border and padding, plus any wrapper chrome.
    const chrome = item.getBoundingClientRect().width - (el.clientWidth - padX)
    grid.set(item, { declared: span, need: Math.ceil(Math.max(bodyNeed, headNeed()) + chrome) })
  }, [grid, gridItem, headNeed, span])

  const fit = useMemo(
    () => ({
      report(px) {
        if (bodyNeedRef.current === px) return
        bodyNeedRef.current = px
        publish()
      },
    }),
    [publish],
  )

  // Re-publish when the header content changes (a count in `right` growing a
  // digit changes what the header needs) and drop out of the grid's map on
  // unmount, so a removed panel never keeps holding a row open.
  useLayoutEffect(() => {
    publish()
  })
  useEffect(() => {
    const item = gridItem()
    return () => {
      if (item && grid) grid.remove(item)
    }
  }, [grid, gridItem])

  const setRef = (node) => {
    ref.current = node
    if (typeof innerRef === 'function') innerRef(node)
    else if (innerRef) innerRef.current = node
  }

  return (
    <div
      ref={setRef}
      className={`bg-card border border-card-border rounded-card p-[18px] ${spanClass} ${className}`}
    >
      {title && (
        // min-w-0 on the text items and shrink-0 on `right`: without them these
        // are flex items at their default min-width:auto, so at a narrow card
        // they refuse to shrink and the whole header row paints OUTSIDE the
        // card, over the panel beside it. Measured before this fix: 13 of 288
        // card headers overflowed at 360-480px viewports, the worst spilling
        // 252px past the card's edge ("Top Subnets by Utilization"), which is
        // what rendered a neighbouring title as "- p Capacity Risks" with "To"
        // covered up. break-words rather than truncate, so a two-word title
        // still wraps onto a second line instead of being ellipsised. No
        // overflow-hidden on the row itself — `right` holds popovers that must
        // be free to paint outside.
        //
        // flex-wrap on the row, then max-w-full + flex-wrap + min-w-0 inputs on
        // `right`, in that order, because each caught a different slice of the
        // same defect. Overflowing headers at 360-1024px went 13 -> 10 -> 6 -> 0
        // of 288 as they went in: the row wrap moves `right` onto its own line,
        // and the rest let the controls it holds (a 220px search box, a select)
        // wrap and shrink once even a whole line is not enough for them. `right`
        // stays shrink-0 relative to the title — squeezing a live control to
        // keep a heading on one line is the wrong way round.
        <div ref={headRef} className="flex flex-wrap items-center gap-2 mb-2 min-w-0">
          <h2 ref={titleRef} className="text-[13.5px] font-semibold min-w-0 break-words">{title}</h2>
          {note && <span ref={noteRef} className="text-[11px] text-dim min-w-0 break-words">{note}</span>}
          <span className="flex-1" />
          {right && <span ref={rightRef} className="shrink-0 max-w-full flex flex-wrap items-center justify-end gap-2 [&_input]:min-w-0 [&_select]:min-w-0">{right}</span>}
        </div>
      )}
      <PanelFitContext.Provider value={fit}>{children}</PanelFitContext.Provider>
    </div>
  )
}

// One-line "what this tab does" line under a tab title, with a link to the
// matching section of docs/TABS.md. Always-visible text rather than a hover
// tooltip: the nav collapses tabs into a ⋯ menu at narrow widths and hover
// does not exist on touch, so a tooltip is the one place this can't be read.
const DOCS_URL = 'https://github.com/holland-built/bloxsmith/blob/master/docs/TABS.md'

export function TabIntro({ anchor, children }) {
  return (
    <p className="text-xs text-muted mb-3 max-w-[80ch]">
      {children}{' '}
      <a
        href={anchor ? `${DOCS_URL}#${anchor}` : DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="text-accent underline underline-offset-2 whitespace-nowrap"
      >
        Docs →
      </a>
    </p>
  )
}

// ---------- write flow ----------
//
// One Preview -> Apply flow for every surface that writes to Infoblox
// (Provision, Self-Service, Editor). Before this, each tab had its own model:
// Editor previewed then revealed Apply, Provision made you untick a checkbox
// and re-run, and Self-Service's two cards used one label ("Dry Run") for two
// different behaviours — one called the server, one only echoed the typed
// values back in a success-styled box.
//
// The rules this encodes:
//   - Preview always runs server-side. A preview that never left the browser
//     validates nothing but still reads as confirmation.
//   - Apply is only reachable from a fresh preview, so what you apply is what
//     you reviewed.
//   - Editing an input after previewing marks the preview stale and hides
//     Apply. Silently applying against changed inputs is the failure mode the
//     whole flow exists to prevent.
//
// This owns the button state machine and the framing only — each tab keeps its
// own fetch/stream logic and renders its own preview body as children, because
// Provision streams SSE while the others are request/response.

const PA_BTN = 'px-3.5 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed'

export function PreviewApply({
  status = 'idle', // 'idle' | 'busy' | 'previewed' | 'applied'
  stale = false,
  disabled = false,
  applyDisabled = false, // extra gate on Apply only (admin role, typed confirm)
  applyNote,
  onPreview,
  onApply,
  previewLabel = 'Preview',
  applyLabel = 'Apply',
  busyLabel = 'Working…',
  destructive = false,
  error,
  message,
  children,
}) {
  const busy = status === 'busy'
  const showApply = status === 'previewed' && !stale && !busy

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPreview}
          disabled={busy || disabled}
          className={PA_BTN}
          style={{ background: COLORS.accent, color: '#fff' }}
        >
          {busy ? busyLabel : previewLabel}
        </button>
        {showApply && (
          <button
            type="button"
            onClick={onApply}
            disabled={applyDisabled}
            className={PA_BTN}
            style={{ background: destructive ? COLORS.crit : COLORS.ok, color: '#fff' }}
          >
            {applyLabel}
          </button>
        )}
        {showApply && applyDisabled && applyNote && (
          <span className="text-[11px]" style={{ color: COLORS.warn }}>{applyNote}</span>
        )}
        {status === 'previewed' && stale && (
          <span className="text-[11px]" style={{ color: COLORS.warn }}>
            inputs changed — preview again
          </span>
        )}
      </div>

      {error && (
        <div
          className="text-sm rounded-lg px-3 py-2"
          style={{ background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)', border: `1px solid ${COLORS.crit}` }}
        >
          {error}
        </div>
      )}
      {/* A stale preview's message ("review it, then apply") is no longer true —
          the warning above replaces it rather than sitting next to it. */}
      {!error && message && !stale && (
        <div
          className="text-sm rounded-lg px-3 py-2"
          style={{ background: 'var(--pill-ok-bg)', color: 'var(--pill-ok-fg)', border: `1px solid ${COLORS.ok}` }}
        >
          {message}
        </div>
      )}

      {/* Dimmed when stale: the body below still shows the OLD payload, and it
          must not read as describing the current inputs. */}
      <div className={stale ? 'opacity-40' : undefined}>{children}</div>
    </div>
  )
}

// Renders a previewed payload. Never styled as success — a preview is a
// statement of intent, not a result, and green reads as "it worked".
export function PreviewBox({ data, note = 'preview — nothing applied yet' }) {
  if (data == null) return null
  return (
    <div className="rounded-lg border border-border bg-field p-3">
      <div className="text-[11px] text-dim mb-1.5">{note}</div>
      <pre className="text-xs whitespace-pre-wrap max-h-[320px] overflow-auto text-muted">
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}

export function Empty({ children = 'no data' }) {
  return <div className="h-full min-h-[100px] flex items-center justify-center text-muted text-sm">{children}</div>
}

// A dead upstream feed must never read as "you have none" — this is visually
// and lexically distinct from <Empty>: no zero-count language, no "no data".
export function FeedUnavailable({ reason, label = 'Feed unavailable' }) {
  const { COLORS } = useChartTheme()
  return (
    <div className="h-full min-h-[100px] flex flex-col items-center justify-center gap-1 text-center px-4">
      <div className="text-sm font-semibold" style={{ color: COLORS.crit }}>{label}</div>
      {reason ? <div className="text-[11px]" style={{ color: COLORS.warn }}>{reason}</div> : null}
    </div>
  )
}

export function Skeleton({ h = 140 }) {
  return <div className="animate-pulse bg-line rounded-lg w-full" style={{ height: h }} />
}

export function Sparkline({ values, color, h = 30 }) {
  if (!values || values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100
      const y = h - ((v - min) / range) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width="100%" height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" points={pts} />
    </svg>
  )
}

export function utilStatus(util) {
  if (util >= 92) return { label: 'Critical', color: 'var(--color-crit)', bg: 'var(--pill-crit-bg)', fg: 'var(--pill-crit-fg)' }
  if (util >= 75) return { label: 'Warning', color: 'var(--color-warn)', bg: 'var(--pill-warn-bg)', fg: 'var(--pill-warn-fg)' }
  return { label: 'Healthy', color: 'var(--color-accent)', bg: 'var(--pill-ok-bg)', fg: 'var(--pill-ok-fg)' }
}

