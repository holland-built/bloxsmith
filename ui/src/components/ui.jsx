import { Children, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useThemeColors } from '../lib/theme.jsx'
import { fmtShortDay, fmtValue } from '../lib/chartFormat.js'
import { PANEL_HELP } from '../lib/panelHelp.js'
import { shouldHidePanel, showAnyway } from '../lib/services.js'
import {
  insertionIndex, loadLayout, moveItem, resolveSpan, saveLayout,
  shiftItem, sortByOrder, spanFromWidth, stepSpan, unseenPanelIds, widthAnnouncement,
} from '../lib/layout.js'

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
  }
}

// ---------- ChartTip ----------
//
// The one thing every chart on this dashboard says when you point at it.
//
// What stood here before was `TT`, a style bag on useChartTheme: it made
// recharts' default tooltip match the theme and left the WORDS to recharts. What
// recharts writes by default is the series' `dataKey` and the raw number behind
// it, which is how eleven charts came to greet a network operator with
// `value : 346.1144444444444` and `requests : 312011` under
// `2026-08-01T00:00:00.000`. Every one of those is accurate about the code and
// useless about the network.
//
// TT is deleted rather than deprecated, and that is the point: while it existed,
// "every chart shares one tooltip" was a convention any new chart could opt out
// of by spreading {...TT}. With it gone, a `<Tooltip>` either uses this component
// or writes raw dataKeys that tests/chart-tooltips.spec.ts fails on.
//
// So the copy decision moves here, once, instead of being made eleven times:
//
//   name    a plain-English label for a SINGLE series, written as the unit it is
//           measured in — "queries per second", "events", "subnets". Reads as
//           "346.1 queries per second", the way a person says it out loud.
//   names   a { dataKey: label } map for a chart with more than one series,
//           where each label is a CATEGORY rather than a unit — "Blocked",
//           "Allowed". Reads as "Blocked  438,914", label first, because that is
//           how a person says a category. Each row carries the series' own
//           colour so the tooltip and the bars agree without a legend.
//
// valueFormat / labelFormat are the escape hatches for the two charts that
// genuinely need their own sentence (Top Consumers already says
// "204 used (80%)", which is better than anything a generic rule would write).
// The defaults are the honest ones: at most one decimal, and dates spelled the
// way people spell them.
//
// Passed to recharts as `content`, so it replaces the default renderer rather
// than decorating it: <Tooltip content={<ChartTip name="queries per second" />} />.
// It draws inside recharts' own tooltip wrapper, which lives in the chart body —
// it adds nothing to a Card header, so none of the header-measurement machinery
// further down this file can see it.
export function ChartTip({
  active, payload, label,
  name, names, valueFormat = fmtValue, labelFormat = fmtShortDay,
}) {
  const colors = useThemeColors()
  if (!active || !payload || payload.length === 0) return null

  // A series that is currently hidden, or one whose value never arrived, has
  // nothing to say — printing "—" for it would invent a row the chart isn't drawing.
  const rows = payload.filter((p) => p && p.value !== null && p.value !== undefined && p.hide !== true)
  if (rows.length === 0) return null

  const head = labelFormat(label, payload)

  return (
    <div
      style={{
        background: colors.field,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        fontSize: 12,
        padding: '6px 9px',
        lineHeight: 1.45,
        // The tooltip follows the cursor across the plot area; letting it take
        // the pointer would steal clicks from the bars and slices underneath,
        // several of which are the drill-down into the tab below.
        pointerEvents: 'none',
      }}
    >
      {head ? <div style={{ color: colors.muted, marginBottom: 2 }}>{head}</div> : null}
      {rows.map((p, i) => {
        const seriesLabel = names ? (names[p.dataKey] ?? names[p.name] ?? null) : null
        const value = valueFormat(p.value, p)
        return (
          <div key={`${p.dataKey ?? p.name ?? i}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {seriesLabel ? (
              <>
                <i
                  aria-hidden="true"
                  style={{
                    width: 8, height: 8, borderRadius: 2, display: 'inline-block', flex: 'none',
                    background: p.color || p.fill || p.stroke || colors.muted,
                  }}
                />
                <span style={{ color: colors.muted }}>{seriesLabel}</span>
                <span style={{ color: colors.txt, fontWeight: 600, marginLeft: 'auto', paddingLeft: 10 }}>{value}</span>
              </>
            ) : (
              <span style={{ color: colors.txt }}>{name ? `${value} ${name}` : value}</span>
            )}
          </div>
        )
      })}
    </div>
  )
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
//
// It is also the SINGLE write site for el.style.gridColumn, which is why the
// saved-layout span override is resolved here rather than written by the Card
// itself. Two writers of one property re-applying on their own schedules is a
// race, and the fit system's ResizeObserver would win it about half the time;
// resolveSpan (lib/layout.js) collapses both into one decision — user span >
// measured need > declared span — taken once per element per frame.
//
// readGeometry is that same read, factored out because item 8's drag and
// resize convert pointer pixels against exactly these numbers. Two independent
// readings of the track width would be a silent divergence waiting to happen:
// the resize would snap to one grid and applyLayout would render against
// another, and the disagreement would only show up as an off-by-one span.
//
// IMPLICIT COLUMNS ARE NOT TRACKS. getComputedStyle serialises the implicit
// columns alongside the declared ones, and an implicit column is exactly what
// a too-wide card creates — so tracks.length lets one over-wide card raise the
// ceiling that is supposed to bring it back down, and the wrong span becomes a
// fixpoint. Measured on #overview after dragging at 1920 and narrowing to 390:
// gridTemplateColumns read "159px 159px 0px" on a grid-cols-2 grid, so
// trackCount read 3, so the card's span 3 clamped to 3 and survived forever.
//
// The grid's own content box is the honest answer, because it does not move
// when an implicit column appears: the declared 1fr tracks simply shrink to
// pay for the extra gap. How many track-plus-gap units fit across clientWidth
// is therefore N whatever the card is doing — algebraically exact when the
// grid is healthy (N*(W+g)/(W+g)), and 2.07 rather than 3 in the case above.
// The epsilon is against float noise in a sub-pixel track width, not against
// the implicit column, which is never within 0.001 of the next integer.
function readGeometry(grid) {
  const gs = getComputedStyle(grid)
  const tracks = gs.gridTemplateColumns.split(' ').filter(Boolean)
  const track = parseFloat(tracks[0])
  if (!tracks.length || !(track > 0)) return null
  const gap = parseFloat(gs.columnGap) || 0
  const fitting = Math.floor((grid.clientWidth + gap) / (track + gap) + 0.001)
  return { track, gap, trackCount: Math.max(1, Math.min(tracks.length, fitting)) }
}

// The grid ITEMS that carry a panel identity, in DOM order — which, with no
// CSS `order` anywhere in this file, is also visual order. Walks grid.children
// rather than querying for [data-panel-id] directly because a couple of
// callers wrap their Card in a plain div, and the drag has to move the real
// grid item, not the Card inside it.
function panelItems(grid) {
  return Array.from(grid.children)
    .map((el) => ({
      el,
      id: el.getAttribute('data-panel-id') || el.querySelector('[data-panel-id]')?.getAttribute('data-panel-id') || null,
    }))
    .filter((entry) => entry.id)
}

function applyLayout(grid, items, overrides) {
  const geo = readGeometry(grid)
  if (!geo) return
  const { track, gap, trackCount } = geo

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
    const measuredSpan = entry && entry.need != null ? spanFor(entry.need) : null
    // trackCount is read live above, so a saved span 6 clamps to 2 on the base
    // grid and back to 6 at xl — the ResizeObserver below re-runs this across
    // every breakpoint change. The STORED span is never touched by the clamp.
    const { span } = resolveSpan({ userSpan: overrides.get(el) ?? null, measuredSpan, trackCount })
    // null span = "leave the declared SPAN_CLASS alone", the untouched path for
    // every panel that neither measures nor carries a saved override.
    if (span == null) continue
    const next = `span ${span} / span ${span}`
    if (el.style.gridColumn !== next) el.style.gridColumn = next
  }
}

// `layoutKey` opts a grid into server-side layout persistence: it names the
// saved view (`__layout_<layoutKey>`) looked up on mount. Everything about the
// feature is behind that one prop — a CardGrid without it issues no request,
// holds no layout state, sorts nothing and registers no override, so every tab
// that has not been wired renders exactly as it did before this existed. A tab
// that has never had a layout saved lands in the same place, which is the
// common case and the one that has to be pixel-identical: measured at 1920 and
// 390 with the feature wired vs. removed, every card's left/top/width and
// computed grid-column were identical.
export function CardGrid({ className = '', layoutKey, children }) {
  const ref = useRef(null)
  const itemsRef = useRef(new Map())
  const overridesRef = useRef(new Map())
  const rafRef = useRef(null)
  const liveRef = useRef(null)
  const [layout, setLayout] = useState(null)
  // Which panel is in keyboard move mode, and the order+spans it had when it
  // entered (what Escape restores).
  //
  // This lives in the GRID, not in the Card that owns the handle, and that is
  // structural: an arrow press rewrites `layout`, which re-sorts the children,
  // and a Card holding its own move-mode state could be re-rendered out from
  // under the gesture. Keeping it here also means one place knows which handle
  // has to keep focus.
  const [moveId, setMoveId] = useState(null)
  const preMoveRef = useRef(null)

  const schedule = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (ref.current) applyLayout(ref.current, itemsRef.current, overridesRef.current)
    })
  }, [])

  useEffect(() => {
    if (!layoutKey) return undefined
    let live = true
    // loadLayout never rejects: a 404, a network failure and a record that
    // fails the strict payload check all resolve to null, i.e. "render as if
    // nothing was ever saved".
    loadLayout(layoutKey).then((loaded) => {
      if (live && loaded) setLayout(loaded)
    })
    return () => {
      live = false
    }
  }, [layoutKey])

  const ctx = useMemo(
    () => ({
      gridRef: ref,
      // The one switch every item-8 affordance hangs off. A grid with no
      // layoutKey hands its Cards `managed: false`, so no handle, no resize
      // hotspot and no pointer listener is created at all — not hidden, not
      // disabled, not rendered.
      managed: !!layoutKey,
      // Read by Card to find its own saved span. undefined when no layout is
      // loaded, which is what makes every Card's override path a no-op.
      spans: layout?.spans,
      // Announcements are written straight to the DOM rather than held in
      // state: "Moved to position 3 of 7" must not re-render the grid it is
      // describing, and a render during a gesture is exactly what re-enters
      // the measurement loops this feature has to stay out of.
      announce(text) {
        if (liveRef.current) liveRef.current.textContent = text
      },
      geometry() {
        return ref.current ? readGeometry(ref.current) : null
      },
      // The live truth of what is on screen, read from the DOM rather than
      // from `layout`. It has to be the DOM: a saved order may omit panels
      // (they render at the end) and may name panels that no longer exist, so
      // only the rendered children answer "what order is this actually in".
      // That also makes "DOM order matches visual order after a drop" true by
      // construction rather than by assertion.
      snapshot() {
        const grid = ref.current
        return {
          order: grid ? panelItems(grid).map((entry) => entry.id) : [],
          spans: { ...(layout?.spans ?? {}) },
        }
      },
      // The single commit path. Pointer drop, pointer resize and keyboard
      // move mode all land here, so all three are validated by the same
      // schema — saveLayout throws on anything validateSave rejects, before
      // it reaches the network. `save: false` is the keyboard preview: the
      // layout moves on screen but nothing is written until Enter.
      apply(next, save) {
        setLayout(next)
        if (save && layoutKey) {
          saveLayout(layoutKey, next).catch((err) => {
            console.error('layout save failed', err)
            if (liveRef.current) liveRef.current.textContent = 'Layout could not be saved'
          })
        }
      },
      // ---- keyboard move mode ----
      //
      // The pointer and the keyboard share everything below the decision: both
      // end at apply(), so both are validated by the same schema on the way to
      // the server. The only thing move mode adds is a preview state — arrows
      // apply without saving, and Enter is what writes.
      moveId,
      beginMove(id, pre) {
        preMoveRef.current = pre
        setMoveId(id)
      },
      endMove(commit, current) {
        const pre = preMoveRef.current
        preMoveRef.current = null
        setMoveId(null)
        if (commit) {
          this.apply(current, true)
        } else if (pre) {
          // Restored locally and NOT saved: nothing was written during move
          // mode, so the server still holds the pre-move state and re-POSTing
          // it would only be a chance to fail.
          setLayout(pre)
        }
      },
      set(itemEl, entry) {
        const prev = itemsRef.current.get(itemEl)
        if (prev && prev.need === entry.need && prev.declared === entry.declared) return
        itemsRef.current.set(itemEl, entry)
        schedule()
      },
      remove(itemEl) {
        if (itemsRef.current.delete(itemEl)) schedule()
      },
      setOverride(itemEl, span) {
        if (overridesRef.current.get(itemEl) === span) return
        overridesRef.current.set(itemEl, span)
        schedule()
      },
      clearOverride(itemEl) {
        // Clearing the inline value as well as the map entry: applyLayout
        // skips an element it has nothing to say about, so without this an
        // un-overridden panel would keep the last span the override wrote.
        if (overridesRef.current.delete(itemEl)) {
          itemEl.style.gridColumn = ''
          schedule()
        }
      },
    }),
    [schedule, layout, layoutKey, moveId],
  )

  // The saved order is applied by rearranging the REAL children, never CSS
  // `order` — see sortByOrder's comment for why DOM order is the thing that
  // has to move.
  //
  // A grid with NO layoutKey passes `children` straight through: no
  // Children.toArray, so no re-keying and no remount on a tab that has not
  // been wired. A grid WITH one is toArray'd from the first render, even
  // before a layout has loaded, and that is deliberate rather than tidy: the
  // two shapes carry different keys, so switching between them mid-session
  // remounts every panel in the tab. That remount lands exactly on the first
  // arrow press of a keyboard move — destroying the focused handle in the
  // middle of the gesture that needs it. Keying the same way from the start
  // removes the transition instead of trying to survive it.
  const ordered = useMemo(() => {
    if (!layoutKey) return children
    const arr = Children.toArray(children)
    const order = layout?.order
    if (!order || order.length === 0) return arr
    return sortByOrder(arr, order, (child) => child?.props?.panelId ?? null)
  }, [children, layout, layoutKey])

  // Focus stays on the handle throughout a keyboard move. React moves the real
  // DOM nodes when the order changes, and a browser blurs an element that is
  // detached and re-inserted, so this puts focus back on the handle after every
  // render the gesture causes. It runs only while move mode is active.
  //
  // RECLAIMS ONLY THE FOCUS THE RE-SORT DROPPED. Written without the
  // activeElement test below, this fired on EVERY render while moveId was set,
  // including renders it had nothing to do with. Observed live on #overview:
  // move mode was entered and abandoned, focus was parked in the "Filter
  // subnets" input, and 35s later the /api/data poll's re-render pulled focus
  // onto the dns-hero Move handle — after which one ArrowRight, typed at what
  // the operator believed was a filter box, reordered the dashboard
  // (dns-hero,kpi-stack,… -> kpi-stack,dns-hero,…).
  //
  // When React moves the focused handle's node the browser leaves
  // document.activeElement at <body>, so <body> (or nothing) is the one state
  // worth reclaiming from. Anything else is focus the operator has since
  // placed on something real, and taking it is the bug. Card's own blur
  // handler is the other half of this: it ends move mode when focus genuinely
  // leaves, so this effect stops running at all.
  useLayoutEffect(() => {
    if (!moveId || !ref.current) return
    const handle = ref.current.querySelector(`[data-panel-id="${CSS.escape(moveId)}"] [data-layout-handle]`)
    if (!handle) return
    const active = document.activeElement
    if (active === handle) return
    if (active && active !== document.body && active !== document.documentElement) return
    handle.focus()
  })

  // ---- the HiddenPanels / layoutKey landmine, made loud ----
  //
  // snapshot() reads panel ids off the DOM, where a wrapped Card is visible;
  // sortByOrder reads props.panelId off the React children, where the wrapper
  // carries none and ranks last. A tab using both would save an order it
  // cannot honour and push the whole wrapped run to the end on reload. Nothing
  // in the repo does today — layoutKey is only on Overview, which uses no
  // HiddenPanels — so this is a guard for whoever wires the second tab.
  //
  // console.error rather than a throw: a broken saved order must not take the
  // tab down. NOT gated behind import.meta.env.DEV, because both the dev
  // server (scripts/dev-serve.sh) and the e2e harness serve a PRODUCTION Vite
  // build — a DEV-only warning would fire in no environment anyone runs.
  // tests/tabs-smoke.spec.ts fails any tab that logs a console error, so this
  // is caught by the existing suite the moment it becomes true.
  const conflictRef = useRef('')
  useEffect(() => {
    if (!layoutKey || !ref.current) return
    const unseen = unseenPanelIds(
      panelItems(ref.current).map((entry) => entry.id),
      Children.toArray(children).map((child) => child?.props?.panelId ?? null),
    )
    // Logged once per distinct set: this effect runs on every render, and a
    // 30s poll repeating the same error forever helps nobody.
    const key = unseen.join(',')
    if (key === conflictRef.current) return
    conflictRef.current = key
    if (!unseen.length) return
    console.error(
      `CardGrid layoutKey="${layoutKey}": ${unseen.join(', ')} ` +
        `${unseen.length === 1 ? 'is a grid item whose' : 'are grid items whose'} panelId this grid ` +
        'cannot see on its own children — a HiddenPanels wrapper, or a plain div carrying the span ' +
        'class. The saved order records these panels but cannot restore them, so they would jump to ' +
        'the end on reload. Put panelId on the direct grid child, or drop layoutKey from this grid.',
    )
  })

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
      <div ref={ref} data-card-grid="" className={`grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-[var(--sp-grid-gap)] ${className}`}>
        {ordered}
      </div>
      {/* One live region per managed grid, OUTSIDE the grid element so it is
          never a grid item and can never take a track. Rendered only when
          layoutKey is set, so an unmanaged tab's DOM is unchanged down to the
          element count. */}
      {layoutKey && <div ref={liveRef} data-layout-live="" aria-live="polite" aria-atomic="true" className="sr-only" />}
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

// ---------- item 8: the overlay layer ----------
//
// Every transient piece of drag chrome — the resize indicator, the drag ghost,
// the insertion line — is created here, appended to document.body, positioned
// with `position: fixed`, and removed when the pointer comes up. None of it is
// React state and none of it is a descendant of a measured card.
//
// That is the structural reason a drag cannot re-enter the three measure ->
// render feedback loops documented above and in DataTable.jsx: the real card
// is never moved, never resized and never re-rendered while the pointer is
// down. A fixed-position element also contributes nothing to any ancestor's
// scrollWidth, so it cannot make a table look like it overflows.
function overlayEl(attr, css) {
  const el = document.createElement('div')
  el.setAttribute(attr, '')
  el.style.cssText = `position:fixed;z-index:60;pointer-events:none;${css}`
  document.body.appendChild(el)
  return el
}

// PanelFitContext is how a self-measuring body (DataTable) tells its Card how
// much width its content actually needs. A body that does not measure simply
// never calls it, and the Card keeps its declared span.
const PanelFitContext = createContext(null)

export function usePanelFit() {
  return useContext(PanelFitContext)
}

// `fit` opts a panel OUT of the content-driven width above, keeping its
// declared span. The content-fit system is right for a dashboard panel, whose
// job is to be as small as its contents allow; it is wrong for a full-page
// primary table, whose job is to be as wide as the page. Measured on #assets at
// 1920: the Assets table reported the natural width of its five columns and the
// grid handed it 4 of 6 tracks (1244px) against the declared span={6} (1872px),
// leaving 628px of the page empty beside the widest table in the app.
// This is a per-card opt-out and not a change to applyLayout on purpose
// — every other measuring panel must keep shrinking to its content.
//
// The one sentence that explains reorder and resize, appended by Card to the
// help of any panel that really is rearrangeable. It lives here rather than in
// panelHelp.js because it is a fact about the LAYOUT SYSTEM, not about a
// panel: which grids are managed can change, and 96 hand-copied sentences
// would go stale the moment one did.
const LAYOUT_HELP =
  'You can move this panel: drag the ⠿ handle, or put the keyboard focus on it, ' +
  'press Enter and use the arrow keys. Drag the panel’s right edge to make it wider ' +
  'or narrower. Your arrangement saves on its own.'

// ---- the runtime half of the help guarantee ----
//
// panelHelp.test.js reads the JSX and catches every LITERAL panelId. What it
// cannot see is a computed one — `panelId={`dns-zone-${view}`}` produces an id
// no static scan can enumerate, and a Card built by a file outside tabs/ and
// components/ is not scanned at all. Those only exist at run time, so this is
// the check that runs there.
//
// NOT gated behind import.meta.env.DEV, for the reason spelled out at the
// HiddenPanels/layoutKey guard above: the dev server and the e2e harness both
// serve a PRODUCTION Vite build, so a DEV-only warning would fire in no
// environment anybody runs. tests/tabs-smoke.spec.ts fails any tab that logs a
// console error, which is what turns this line into a test.
//
// Once per id, because a Card re-renders on every fit measurement and a
// per-render error would bury the tab's real output in thousands of copies.
const reportedHelpGaps = new Set()

function reportMissingHelp(panelId, title) {
  const key = panelId || `\0no-panel-id:${typeof title === 'string' ? title : '(computed title)'}`
  if (reportedHelpGaps.has(key)) return
  reportedHelpGaps.add(key)
  if (!panelId) {
    console.error(
      `[panel-help] a Card rendered with no panelId (title: ${
        typeof title === 'string' ? `"${title}"` : 'not a plain string'
      }). Without an id it has no help, and the layout system cannot see it.`,
    )
    return
  }
  console.error(
    `[panel-help] panelId "${panelId}" has no entry in PANEL_HELP, so this panel's ⓘ ` +
      'button does not render. Add an entry to ui/src/lib/panelHelp.js.',
  )
}

// `panelId` is the stable identity a saved layout refers to. Explicit, never
// derived from the title: a title is copy, it gets reworded, and a layout
// keyed on it would silently detach from its panel the first time someone
// edited a heading. A Card without one is invisible to the layout system.
export function Card({ title, note, right, span = 2, panelId, fit: fitEnabled = true, className = '', innerRef, children }) {
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
    // Two independent doors into applyLayout, so an opted-out card closes both:
    // the body's fit.report (blocked by handing PanelFitContext null below) and
    // this header-need path, which the layout effect calls on every render.
    if (!fitEnabled) return
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
  }, [fitEnabled, grid, gridItem, headNeed, span])

  // null, not a no-op reporter: usePanelFit() returning null is the shape
  // DataTable already tests for (`if (fit) fit.report(...)`), so an opted-out
  // card costs the body nothing to measure and nothing to send.
  const fit = useMemo(
    () =>
      fitEnabled
        ? {
            report(px) {
              if (bodyNeedRef.current === px) return
              bodyNeedRef.current = px
              publish()
            },
          }
        : null,
    [fitEnabled, publish],
  )

  // Re-publish when the header content changes (a count in `right` growing a
  // digit changes what the header needs) and drop out of the grid's map on
  // unmount, so a removed panel never keeps holding a row open.
  //
  // THE EVICTION IS UNMOUNT-ONLY, and that is not tidiness. `grid` is the ctx
  // memo whose deps include `layout`, so every drop, resize, arrow press and
  // the initial loadLayout resolve hands this Card a NEW ctx object. An effect
  // keyed on [grid, gridItem] therefore ran its cleanup — grid.remove(item) —
  // on every layout change, emptying the fit map for every card at once, and
  // the re-registration that would repair it never came: publish() runs in the
  // LAYOUT phase, before this passive cleanup, and set() early-returns on an
  // unchanged entry. The map then stayed empty until the next 30s data poll
  // re-rendered the Cards.
  //
  // Measured on #overview at 1920 before this change: drag a panel, then
  // narrow to 390 inside that window and the grid computed
  // `159px 159px 0px` — a third, implicit column — with subnet-table and
  // license-inventory still carrying the `span 3 / span 3` written for six
  // tracks and rendering 342px against every other card's 330px. Escape out of
  // move mode had the same root cause: clearOverride blanked gridColumn and
  // applyLayout, with no measured span left to fall back on, skipped the card
  // down to its declared SPAN_CLASS.
  const evictRef = useRef(null)
  useLayoutEffect(() => {
    publish()
    evictRef.current = grid ? { grid, item: gridItem() } : null
  })
  useEffect(
    () => () => {
      const evict = evictRef.current
      if (evict?.item) evict.grid.remove(evict.item)
    },
    [],
  )

  // The saved span, registered against the real grid item (which is this Card
  // unless a caller wrapped it). Registered rather than written: applyLayout
  // owns the one write to gridColumn, so this only tells it what the user
  // chose and lets it resolve the precedence. undefined savedSpan — no
  // layoutKey, no panelId, or a layout that does not mention this panel —
  // clears nothing that was never set.
  const savedSpan = panelId && grid?.spans ? grid.spans[panelId] : undefined
  useLayoutEffect(() => {
    if (!grid?.setOverride) return undefined
    const item = gridItem()
    if (!item) return undefined
    if (typeof savedSpan === 'number') grid.setOverride(item, savedSpan)
    else grid.clearOverride(item)
    return () => grid.clearOverride(item)
  }, [grid, gridItem, savedSpan])

  const setRef = (node) => {
    ref.current = node
    if (typeof innerRef === 'function') innerRef(node)
    else if (innerRef) innerRef.current = node
  }

  // A panel is rearrangeable only inside a grid that persists layouts AND only
  // if it has the stable identity a saved layout refers to. Both, or neither:
  // a handle on a panel with no panelId would move something nothing could
  // record.
  const managed = !!(grid?.managed && panelId)

  // ---- resize: the right-edge hotspot ----
  //
  // Live preview is an INDICATOR LINE, never live reflow. The card keeps the
  // width it had until the pointer comes up; only then is a whole-integer span
  // written, through the same save path everything else uses. Re-sizing the
  // real card on every pointermove is the exact shape of the bug the fit
  // system's comments above were written about.
  const onResizeDown = useCallback(
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const item = gridItem()
      const geo = grid?.geometry?.()
      if (!item || !geo) return
      // Stops the pointerdown from reaching a row handler or starting a text
      // selection; deliberately NOT a document-level listener, so nothing
      // about wheel, scroll or click anywhere else changes.
      e.preventDefault()
      e.stopPropagation()
      const hotspot = e.currentTarget
      try {
        hotspot.setPointerCapture(e.pointerId)
      } catch {
        // Capture is an optimisation (it keeps events coming if the pointer
        // leaves the element); the listeners below work without it.
      }
      const { track, gap, trackCount } = geo
      let span = spanFromWidth(item.getBoundingClientRect().width, track, gap, trackCount)
      const line = overlayEl('data-layout-resize-indicator', 'width:2px;border-radius:1px;background:var(--color-accent);')
      const place = (rect, s) => {
        line.style.left = `${rect.left + s * track + (s - 1) * gap - 1}px`
        line.style.top = `${rect.top}px`
        line.style.height = `${rect.height}px`
      }
      place(item.getBoundingClientRect(), span)

      const ac = new AbortController()
      const { signal } = ac
      const done = (commit) => {
        ac.abort()
        line.remove()
        if (!commit) return
        const snap = grid.snapshot()
        grid.apply({ order: snap.order, spans: { ...snap.spans, [panelId]: span } }, true)
        // spanFromWidth already clamped to trackCount, so this can only take
        // the plain branch — it goes through the same function as the keyboard
        // so the two routes can never drift into announcing differently.
        grid.announce(widthAnnouncement(span, trackCount))
      }
      // The rect is re-read each move rather than captured once: the page can
      // still be scrolled under a captured pointer, and a stale top would put
      // the indicator somewhere the card no longer is.
      hotspot.addEventListener(
        'pointermove',
        (ev) => {
          const rect = item.getBoundingClientRect()
          span = spanFromWidth(ev.clientX - rect.left, track, gap, trackCount)
          place(rect, span)
        },
        { signal },
      )
      hotspot.addEventListener('pointerup', () => done(true), { signal })
      hotspot.addEventListener('pointercancel', () => done(false), { signal })
    },
    [grid, gridItem, panelId],
  )

  // A panel's `title` is not always a string — Overview's DNS hero passes a
  // clickable <span> so the heading deep-links to the DNS tab. Interpolating
  // that into a template literal produces the accessible name
  // "Move [object Object]", which is why the handle is labelled by REFERENCE
  // (a hidden "Move" plus the real <h2>) whenever a title exists, and only
  // falls back to aria-label for the titleless case. Announcements read the
  // heading's RENDERED text instead, which works for both shapes.
  const titleId = panelId ? `panel-title-${panelId}` : undefined
  const moveWordId = panelId ? `panel-move-${panelId}` : undefined
  const labelText = useCallback(
    () => (typeof title === 'string' ? title : titleRef.current?.textContent || panelId),
    [panelId, title],
  )

  // ---- drag: a header handle, a ghost, and an insertion line ----
  //
  // What moves during the drag is a ghost appended to document.body. The real
  // card is not translated, not re-parented and not re-rendered until the
  // pointer comes up — the drop rewrites the saved `order`, which re-sorts the
  // real children (sortByOrder), so DOM order and visual order can never
  // disagree the way a CSS-`order` implementation would let them.
  const onHandleDown = useCallback(
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const gridEl = grid?.gridRef?.current
      const item = gridItem()
      if (!gridEl || !item) return
      const handleEl = e.currentTarget
      const startX = e.clientX
      const startY = e.clientY
      let started = false
      let ghost = null
      let line = null
      let items = []
      let target = 0

      const ac = new AbortController()
      const { signal } = ac

      // Nothing is created until the pointer has actually travelled. Below the
      // threshold this is a click on a button, and a button that is also a
      // keyboard control must stay clickable and focusable.
      const begin = () => {
        started = true
        items = panelItems(gridEl)
        const rect = item.getBoundingClientRect()
        ghost = overlayEl(
          'data-layout-ghost',
          `width:${Math.round(rect.width)}px;height:${Math.round(Math.min(rect.height, 120))}px;` +
            'border-radius:12px;border:2px solid var(--color-accent);background:var(--color-card);' +
            'opacity:.9;padding:12px;font:600 13px system-ui,sans-serif;color:var(--color-txt);overflow:hidden;',
        )
        ghost.textContent = labelText()
        line = overlayEl('data-layout-insert-line', 'width:3px;border-radius:2px;background:var(--color-accent);')
        // Scoped to the gesture and reversed in finish(): without it a drag
        // across the page selects every heading it crosses.
        document.body.style.userSelect = 'none'
      }

      const placeLine = (idx) => {
        if (!items.length) return
        const last = idx >= items.length
        const r = items[last ? items.length - 1 : idx].el.getBoundingClientRect()
        line.style.left = `${(last ? r.right + 3 : r.left - 6)}px`
        line.style.top = `${r.top}px`
        line.style.height = `${r.height}px`
      }

      const finish = (commit) => {
        ac.abort()
        if (ghost) ghost.remove()
        if (line) line.remove()
        document.body.style.userSelect = ''
        if (!commit || !started) return
        const snap = grid.snapshot()
        const next = moveItem(snap.order, snap.order.indexOf(panelId), target)
        grid.apply({ order: next, spans: snap.spans }, true)
        grid.announce(`Moved to position ${next.indexOf(panelId) + 1} of ${next.length}`)
      }

      handleEl.addEventListener(
        'pointermove',
        (ev) => {
          if (!started) {
            if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return
            begin()
          }
          ghost.style.left = `${ev.clientX + 10}px`
          ghost.style.top = `${ev.clientY + 10}px`
          // Re-read each move rather than caching at begin(): the real cards
          // do not move during a drag, but the page underneath them can still
          // be scrolled, and a stale rect would aim the drop at the wrong slot.
          target = insertionIndex(
            items.map((entry) => entry.el.getBoundingClientRect()),
            ev.clientX,
            ev.clientY,
          )
          placeLine(target)
        },
        { signal },
      )
      handleEl.addEventListener('pointerup', () => finish(true), { signal })
      handleEl.addEventListener('pointercancel', () => finish(false), { signal })
      try {
        handleEl.setPointerCapture(e.pointerId)
      } catch {
        // Best-effort, as with resize: the listeners above work without it.
      }
    },
    [grid, gridItem, labelText, panelId],
  )

  // ---- keyboard: move mode ----
  //
  // The keyboard does everything the pointer does, not merely cancel: Left and
  // Right move the card one position, Up and Down change its width by one
  // column, Enter saves, Escape puts back both the order AND the span. A
  // focusable handle with only an Escape key is not accessible reordering, it
  // is an accessible way to give up.
  const moveActive = managed && grid.moveId === panelId

  // Move mode has to end when focus genuinely leaves the handle, and it is the
  // word GENUINELY that makes this awkward: an arrow press re-sorts the real
  // DOM children, React moves the focused handle's node, and the browser
  // blurs it. That blur is the component's own re-render, not the operator
  // leaving, and CardGrid's layout effect puts focus straight back in the same
  // commit.
  //
  // So the decision is deferred by one task. A re-sort blur has been undone by
  // the time this runs (activeElement is the handle again); a real one has
  // not. Measured before this existed: entering move mode, clicking into the
  // "Filter subnets" input and waiting one 30s poll left aria-pressed="true"
  // the whole time, and the next ArrowRight reordered the tab.
  //
  // Cancel rather than commit, because nothing was written: arrow presses
  // apply with save:false and only Enter POSTs, so restoring the pre-move
  // state is the only outcome that leaves the screen and the server agreeing.
  const handleRef = useRef(null)
  const moveActiveRef = useRef(false)
  useLayoutEffect(() => {
    moveActiveRef.current = moveActive
  }, [moveActive])

  const onHandleBlur = useCallback(() => {
    if (!moveActiveRef.current) return
    setTimeout(() => {
      // Read through the ref, not the closure: Enter and Escape can have ended
      // move mode between the blur and this callback, and re-cancelling would
      // announce a cancellation that did not happen.
      if (!moveActiveRef.current) return
      if (document.activeElement === handleRef.current) return
      grid.endMove(false)
      grid.announce(`Move cancelled. ${labelText()} is back where it started.`)
    }, 0)
  }, [grid, labelText])

  // The span this card is rendering right now: the saved override if it has
  // one, otherwise whatever applyLayout or the declared SPAN_CLASS put on the
  // element. Read from the DOM rather than assumed, so the first Arrow Up on a
  // measured table panel steps up from the width the operator can SEE, not
  // from the span the JSX declared.
  const liveSpan = useCallback(() => {
    if (typeof savedSpan === 'number') return savedSpan
    const item = gridItem()
    if (!item) return span
    const match = /span (\d+)/.exec(item.style.gridColumn || getComputedStyle(item).gridColumnEnd || '')
    return match ? Number(match[1]) : span
  }, [gridItem, savedSpan, span])

  const onHandleKey = useCallback(
    (e) => {
      if (!managed) return
      const label = labelText()

      if (!moveActive) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          // preventDefault on Space is not cosmetic: without it the browser
          // scrolls the page AND synthesises a click on this button.
          e.preventDefault()
          const snap = grid.snapshot()
          grid.beginMove(panelId, snap)
          grid.announce(
            `Moving ${label}. Position ${snap.order.indexOf(panelId) + 1} of ${snap.order.length}. ` +
              'Left and right arrows to move, up and down to change width, Enter to save, Escape to cancel.',
          )
        }
        return
      }

      const snap = grid.snapshot()
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const next = shiftItem(snap.order, panelId, e.key === 'ArrowLeft' ? -1 : 1)
        // A no-op at either end returns the same array, so the position is
        // re-announced rather than a move being claimed that did not happen.
        grid.apply({ order: next, spans: snap.spans }, false)
        grid.announce(`Moved to position ${next.indexOf(panelId) + 1} of ${next.length}`)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = stepSpan(liveSpan(), e.key === 'ArrowUp' ? 1 : -1)
        grid.apply({ order: snap.order, spans: { ...snap.spans, [panelId]: next } }, false)
        // The STORED span is `next`, unclamped on purpose (stepSpan's comment);
        // what gets rendered is that clamped to the tracks this breakpoint
        // actually has, and the announcement is about what renders.
        grid.announce(widthAnnouncement(next, grid.geometry()?.trackCount))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        grid.endMove(true, snap)
        grid.announce(`${label} placed at position ${snap.order.indexOf(panelId) + 1} of ${snap.order.length}. Layout saved.`)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        grid.endMove(false)
        grid.announce(`Move cancelled. ${label} is back where it started.`)
      }
    },
    [grid, labelText, liveSpan, managed, moveActive, panelId],
  )

  const handle = managed ? (
    <button
      type="button"
      ref={handleRef}
      data-layout-handle=""
      // The panel's own words, so a screen reader announces which panel this
      // moves — never a bare "drag handle" repeated seven times down a tab.
      {...(title ? { 'aria-labelledby': `${moveWordId} ${titleId}` } : { 'aria-label': `Move ${panelId}` })}
      aria-pressed={moveActive}
      title="Drag to move, or press Enter to move with the arrow keys"
      onPointerDown={onHandleDown}
      onKeyDown={onHandleKey}
      onBlur={onHandleBlur}
      className={`shrink-0 cursor-grab touch-none select-none rounded-md border px-1.5 py-0.5 text-[11px] leading-none ${
        moveActive ? 'border-accent text-accent' : 'border-border text-dim hover:text-field-txt hover:border-border-hover'
      }`}
    >
      {title && <span id={moveWordId} className="sr-only">Move</span>}
      ⠿
    </button>
  ) : null

  // ---- the ⓘ panel-help disclosure ----
  //
  // Tap to open, not hover, and not a `title=` tooltip — the same reasoning
  // already written above TabIntro at the bottom of this file: hover does not
  // exist on touch, so a tooltip is unreadable on exactly the devices a
  // dashboard gets glanced at from. A native <button> also makes Enter, Space,
  // focus and the expanded/collapsed announcement free.
  //
  // WHERE THE BUTTON GOES IS NOT A FREE CHOICE. It renders INSIDE the rightRef
  // span alongside the drag handle, for the reason spelled out at that span:
  // headNeed measures the width floor as title + gap + rightRef.scrollWidth,
  // so a header control rendered as a SIBLING of that span is width the
  // measurement cannot see, and the header overflows the card by exactly that
  // control's width. Inside it, it is counted for free. Its own width is
  // intrinsic — shrink-0, one glyph — so unlike the flex-1 spacer of failed
  // attempt #1 it cannot grow with the panel and cannot re-enter the loop. It
  // does raise every measured panel's width floor by its own width, which is
  // the one real cost and what tests/table-sizing.spec.ts is re-run for.
  //
  // The BODY is a block BELOW the header and is invisible to both measurers:
  // headNeed reads only the title canvas and rightRef, bodyNeed is whatever
  // DataTable reported about its own table. The fit system is width-only, so
  // the height this adds costs nothing.
  //
  // The CONTAINER is rendered even while collapsed, with `hidden`, so
  // aria-controls always resolves. A reference to an element that does not
  // exist is the shape HiddenPanels' comment below already rejects.
  //
  // Its CONTENTS are not. A closed disclosure holds no text, because text in
  // the DOM that nobody can read is not free: with 83 entries, every tab was
  // carrying a few thousand words of `display:none` prose, and anything that
  // matches on document text rather than on what is painted matches it. That
  // is not hypothetical — it broke eight existing Playwright specs at once
  // (audit-verdict, dossier-page, exposure-availability, hidden-panels,
  // per-tab-slices), each of which locates a panel by a phrase that the help
  // copy happens to reuse: `text=DNS Zones` began matching dns-zone-kpis'
  // invisible "How many DNS zones you hold…" before it reached the real <h2>.
  // The app was correct and the panels rendered; the page simply contained
  // words it was not showing. Find-in-page, copy-all, translation tools and
  // text scrapers all read the same way a test locator does, so keeping the
  // copy out of the document until it is asked for is the honest shape, and
  // it kept all eight specs' assertions untouched.
  const help = panelId ? PANEL_HELP[panelId] : null
  // In an effect, not in the render body: React renders a component twice under
  // StrictMode and again on every fit pass, and an error thrown from render
  // ordering is harder to read than one attached to a mount.
  useEffect(() => {
    if (!help) reportMissingHelp(panelId, title)
  }, [help, panelId, title])
  const [helpOpen, setHelpOpen] = useState(false)
  const helpId = panelId ? `panel-help-${panelId}` : undefined
  const aboutWordId = panelId ? `panel-about-${panelId}` : undefined

  const infoBtn = help ? (
    <button
      type="button"
      data-panel-help-toggle=""
      // Labelled by REFERENCE for the same reason as the handle above: a title
      // can be a React node, and interpolating one into a template literal
      // gives the accessible name "About [object Object]".
      {...(title ? { 'aria-labelledby': `${aboutWordId} ${titleId}` } : { 'aria-label': `About ${panelId}` })}
      aria-expanded={helpOpen}
      aria-controls={helpId}
      onClick={() => setHelpOpen((open) => !open)}
      className={`shrink-0 cursor-pointer rounded-md border px-1.5 py-0.5 text-[11px] leading-none ${
        helpOpen ? 'border-accent text-accent' : 'border-border text-dim hover:text-field-txt hover:border-border-hover'
      }`}
    >
      {title && <span id={aboutWordId} className="sr-only">About:</span>}
      ⓘ
    </button>
  ) : null

  const helpBody = help ? (
    <div
      id={helpId}
      data-panel-help=""
      hidden={!helpOpen}
      className="mb-2 rounded-lg border border-line-2 bg-line px-2.5 py-2 text-[11px] leading-relaxed text-muted max-w-[80ch]"
    >
      {helpOpen && (
        <>
          <p>{help.what}</p>
          {help.look && <p className="mt-1">{help.look}</p>}
          {/* Generated, never written per panel: reorder and resize exist only
              on a grid with a layoutKey, so a hand-written sentence would go
              stale the moment a grid was wired or unwired. It is also the only
              place the feature is stated at all — the resize hotspot is
              opacity-0 until hover, i.e. invisible on touch. */}
          {managed && <p className="mt-1">{LAYOUT_HELP}</p>}
        </>
      )}
    </div>
  ) : null

  return (
    <div
      ref={setRef}
      data-panel-id={panelId}
      // `relative` is the positioning context for the resize hotspot below.
      // It is inert on its own — no offsets are set on the card itself — so it
      // changes no geometry, and the hotspot is absolutely positioned, so it
      // is out of flow and invisible to every measurement in this file.
      data-move-mode={moveActive ? '' : undefined}
      // The ring is drawn OUTSIDE the border box (ring, not an extra border),
      // so entering move mode does not change the card's content width and
      // cannot nudge a measured table by a pixel.
      className={`relative bg-card border border-card-border rounded-card p-[var(--sp-card-pad)] ${moveActive ? 'ring-2 ring-accent' : ''} ${spanClass} ${className}`}
    >
      {managed && (
        // An 8px strip over the card's own right padding, not over its
        // content: a DataTable's cells stop at the padding edge, so this
        // cannot sit on top of a row and swallow its click. It carries no
        // wheel, scroll or click handler of any kind.
        <div
          data-layout-resize=""
          title="Drag to resize"
          onPointerDown={onResizeDown}
          className="absolute top-0 right-0 h-full w-2 cursor-col-resize touch-none rounded-r-card opacity-0 hover:opacity-100 focus-visible:opacity-100"
          style={{ background: 'linear-gradient(to right, transparent, var(--color-accent))' }}
        />
      )}
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
          <h2 id={titleId} ref={titleRef} className="text-[13.5px] font-semibold min-w-0 break-words">{title}</h2>
          {note && <span ref={noteRef} className="text-[11px] text-dim min-w-0 break-words">{note}</span>}
          <span className="flex-1" />
          {/* The drag handle goes INSIDE the `right` slot, not beside it, and
              that placement is the whole reason headNeed keeps working: the
              floor under a panel's width is measured as title + gap +
              rightRef.scrollWidth, so a handle rendered as a sibling of this
              span would be a header element the measurement could not see —
              and the header would overflow the card by exactly the handle's
              width. Sitting inside rightRef, it is counted for free. */}
          {(right || infoBtn || handle) && (
            <span ref={rightRef} className="shrink-0 max-w-full flex flex-wrap items-center justify-end gap-2 [&_input]:min-w-0 [&_select]:min-w-0">
              {right}
              {infoBtn}
              {handle}
            </span>
          )}
        </div>
      )}
      {/* A managed panel with no title (Overview's KPI stack) has no header to
          put the handle in. Absolutely positioned rather than given a header
          of its own: adding a header row would change that card's layout, and
          "zero visual change until you actually use the feature" is the rule
          this whole item is built under. Out of flow, so no measurement in
          this file can see it either. */}
      {/* Widened from `managed && !title` to cover the help button too: a
          titleless panel with neither renders nothing, exactly as before. */}
      {!title && (infoBtn || handle) && (
        <span className="absolute top-2 right-3 z-10 flex items-center gap-1.5">
          {infoBtn}
          {handle}
        </span>
      )}
      {helpBody}
      <PanelFitContext.Provider value={fit}>{children}</PanelFitContext.Provider>
    </div>
  )
}

// ---------- panels for services this tenant does not own ----------
//
// Wraps a contiguous run of grid children and either renders them exactly as
// they were, or replaces the whole run with one compact row. Nothing about a
// shown panel changes: HiddenPanels renders a fragment, so its children stay
// DIRECT children of the CardGrid and keep their own spans and content-fit
// measurement. That is why this wraps at the Card boundary and never reaches
// inside a panel's own state machine — the two tabs this is applied to are the
// biggest in the repo, and their conditional rendering is untouched.
//
// The collapsed row is itself a grid child, but it never registers with the
// grid's fit map, so applyLayout skips it and it keeps the full-width span
// class below.
//
// The group's session key is derived from the service list, so two separate
// runs that need the same service (DNS Query Rate and DNS Services sit either
// side of a panel that is NOT hidden) share one "show anyway": revealing one
// reveals both, which is what an operator who asked to see the DNS panels
// meant.
export function HiddenPanels({ services, label, state, children }) {
  const groupKey = [...services].sort().join('+')
  const n = Children.count(children)
  const hidden = shouldHidePanel(state, services) && !state.revealed.has(groupKey) && n > 0

  // WHERE FOCUS GOES WHEN THE RUN IS REVEALED. The button that had focus is
  // unmounted by its own click — this component renders a fragment once the
  // panels are shown — so without this, focus falls to <body> and a keyboard
  // or screen-reader user is dropped back at the top of the document with no
  // way to tell whether anything appeared.
  //
  // The slot is remembered as "whatever follows this row's previous sibling",
  // not as a child index: `showAnyway` reveals every group sharing this key at
  // once (DNS Query Rate and DNS Services sit either side of a panel that is
  // NOT hidden), so an earlier group expanding from one row into several
  // panels shifts every index after it. A sibling reference survives that.
  const rowRef = useRef(null)
  const focusSlotRef = useRef(null)
  useLayoutEffect(() => {
    const slot = focusSlotRef.current
    focusSlotRef.current = null
    if (!slot) return
    const el = slot.prev ? slot.prev.nextElementSibling : slot.parent.firstElementChild
    if (!el) return
    // tabindex -1, so it is focusable by script and stays out of the tab order.
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus()
  })

  if (!hidden) return <>{children}</>

  const reveal = () => {
    const row = rowRef.current
    const parent = row?.parentElement
    if (parent) focusSlotRef.current = { parent, prev: row.previousElementSibling }
    showAnyway(groupKey)
  }

  return (
    <div
      ref={rowRef}
      data-testid="hidden-panels"
      className="col-span-2 md:col-span-4 xl:col-span-6 flex flex-wrap items-center gap-2 rounded-card border border-dashed border-card-border px-3 py-2 text-[11px] text-muted"
    >
      <span>
        {n} panel{n === 1 ? '' : 's'} hidden — no {label} service detected on this tenant
      </span>
      <button
        type="button"
        onClick={reveal}
        // "show anyway" on its own is the same name on every group on the page
        // and says nothing about what would appear — a screen reader reads the
        // identical button two or three times down one tab. The accessible
        // name STARTS with the visible words, so WCAG 2.5.3 Label in Name
        // still holds and a voice-control user can still say "show anyway".
        aria-label={`Show anyway: ${n} hidden ${label} panel${n === 1 ? '' : 's'}`}
        // A collapsed disclosure, which is what this is. No aria-controls: the
        // panels it reveals are UNMOUNTED while it is on screen, and once they
        // exist this button is gone, so any id here would be a dangling
        // reference. The focus move above is what stands in for it.
        aria-expanded={false}
        className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted cursor-pointer hover:text-field-txt"
      >
        show anyway
      </button>
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

