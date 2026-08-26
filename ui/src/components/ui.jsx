import { lazy, Suspense, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, Children } from 'react'
import { retryFailedFeeds, useFeedRecovery } from '../lib/api.js'
import { markArranged } from '../lib/arrangedOnce.js'
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
  // Foregrounds for the three FILLED buttons. These are not decoration: white
  // measured 3.79:1 on dark crit, 1.74:1 on dark ok and 3.30:1 on light ok, all
  // below WCAG AA's 4.5:1, and all three were shipping as `color: '#fff'`.
  // index.css carries the full table and the reasoning.
  onAccent: 'var(--color-on-accent)', onCrit: 'var(--color-on-crit)', onOk: 'var(--color-on-ok)',
}

// THE ONE FOCUS RING, AND WHY IT IS A RING RATHER THAN AN OUTLINE.
//
// This class string was copy-pasted into 17 filter inputs and selects across
// eleven tabs, and every copy carried `outline-none` with nothing put back.
// Measured before this change: `grep -rn outline-none ui/src --include=*.jsx`
// returned 28 lines, 25 with no focus replacement on the same line, 17 of them
// form controls. Tabbing to the Assets search box, the Audit date filters or
// either Network select produced no visible change anywhere on the page.
//
// `ring-2 ring-inset` and not `outline`: a ring is a box-shadow, so it occupies
// no layout box. DataTable measures its column widths with a canvas and adds a
// hard-coded CELL_PAD (DataTable.jsx), and Card publishes its own width from
// getComputedStyle (publish() below). An outline would be geometry-neutral too,
// but ring-inset also paints INSIDE the border box, so a control sitting flush
// against a card edge cannot bleed its focus state over the neighbour.
//
// FIELD_CLS carries no width. Callers append their own (`w-[220px]`, `w-full`),
// which is how the 17 sites already differed from one another.
export const FOCUS_RING = 'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset'
export const FIELD_CLS = `px-2.5 py-1.5 rounded-control border border-border bg-field text-field-txt text-copy outline-none focus-visible:border-accent ${FOCUS_RING}`

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
        // var() strings, not values read out through getComputedStyle: these
        // are CSS declarations on a real element, so the browser resolves them
        // at paint. Reading the tokens in JS would mean reading them before the
        // stylesheet has applied on a cold load and baking in an empty string.
        borderRadius: 'var(--radius-control)',
        fontSize: 'var(--text-note)',
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
                    width: 8, height: 8, borderRadius: 'var(--radius-mark)', display: 'inline-block', flex: 'none',
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
// THE TRACK COUNT COMES FROM THE SAME BREAKPOINT THE CSS USES, never from
// getComputedStyle().gridTemplateColumns, and this is the third and last
// attempt at the class of bug documented at headNeed below: a DOM width that is
// itself a function of the width being decided.
//
// WHAT THE SERIALISATION ACTUALLY SAYS. gridTemplateColumns lists the IMPLICIT
// columns alongside the declared ones, and an implicit column is exactly what a
// card carrying an inline `span 6` written for the xl grid creates once the
// window narrows to two tracks. Measured on this tree at b41767a by loading at
// 1920 and narrowing to 390:
//
//   #security   "0px 0px 110.3px 110.3px 73.4px"   5 "tracks", widest span 5
//   #network    "0px 0px 153px 153px"              4 "tracks", widest span 4
//   #incidents  "23.6px 23.6px 129.4px 129.4px"    4 "tracks", widest span 4
//
// The declared minmax(0,1fr) tracks are crushed toward 0 to pay for implicit
// columns that take real width. So BOTH inputs the old code read were poisoned
// at once: tracks.length rose AND tracks[0] fell, which made the "how many
// track-plus-gap units fit across clientWidth" defence — written against an
// implicit column assumed to be 0px — compute a larger count, not a smaller
// one. The clamp stopped clamping, the span 6 survived at 390px, and that is
// what kept the implicit columns alive. Self-sustaining, and it never
// recovered: re-measured a second later it was byte-identical.
//
// The 41px card people report is the VICTIM, not the offender. It never
// measures itself, so publish() bails and applyLayout skips it — it is simply
// what is left of one 1fr track once its neighbours have eaten the grid.
//
// WHY THIS TERMINATES. `--grid-tracks` is declared on [data-card-grid] in
// index.css with media queries at the same thresholds as the element's own
// Tailwind classes. Every input below is strictly upstream of the output:
//
//   - a custom property inherits DOWN, so no child can change it;
//   - the media queries key off the viewport, which no element affects;
//   - clientWidth is a block-level div's padding box, set by its ancestor and
//     never widened by an overflowing child.
//
// One pass, no cycle, nothing to converge to or diverge from. That is what
// makes this different from attempts 1 and 2, both of which closed a loop.
//
// The arithmetic is the grid's own: N tracks share whatever is left of
// clientWidth after the N-1 gaps between them, which is the definition of
// repeat(N, minmax(0,1fr)). No parse, so nothing a card does can be read back
// as geometry.
//
// A grid whose custom property has not resolved — no stylesheet, a detached
// node, a test that mounts the element bare — returns null, and every caller
// already reads that as "say nothing": applyLayout returns before it writes,
// and the drag/resize hotspots decline to start. That is the same silence the
// old code produced for an unresolved gridTemplateColumns, and it is safer than
// guessing a count.
function readGeometry(grid) {
  const gs = getComputedStyle(grid)
  const trackCount = parseInt(gs.getPropertyValue('--grid-tracks'), 10)
  if (!Number.isInteger(trackCount) || trackCount < 1) return null
  const gap = parseFloat(gs.columnGap) || 0
  const track = (grid.clientWidth - (trackCount - 1) * gap) / trackCount
  if (!(track > 0)) return null
  return { track, gap, trackCount }
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
    //
    // CLEARED, NOT SKIPPED. `continue` alone meant an element that had ONCE
    // been given a span kept it for ever: the measurement that produced it can
    // go away (a panel whose table unmounts, a card evicted from the fit map)
    // while the inline `span 6 / span 6` written for the xl grid stays on the
    // element, asking a two-track grid for six columns. Writing '' hands the
    // element back to its responsive SPAN_CLASS, which is what "leave it alone"
    // was always supposed to mean. Guarded on the current value so an element
    // that never carried one — most grid children — is not written to at all.
    if (span == null) {
      if (el.style.gridColumn) el.style.gridColumn = ''
      continue
    }
    const next = `span ${span} / span ${span}`
    if (el.style.gridColumn !== next) el.style.gridColumn = next
  }
}

// ---- the save pill: the layout feature's only word to a SIGHTED operator ----
//
// WHY THERE IS A SECOND ELEMENT AT ALL, when the live region already carries
// this news. Two reasons, and each one is on its own sufficient.
//
//   1. The live region is `sr-only` and has to stay that way. Unhiding it would
//      make a screen-reader user hear every message twice — once from the live
//      region firing, once when they read the page — and would put "Moved to
//      position 3 of 7" permanently on screen for everyone else. So the region
//      keeps its job (assistive tech, every message) and the pill gets a
//      narrower one (sighted operators, the save verdict only).
//   2. tests/layout-drag.spec.ts pins the region's exact text with `toBe` in
//      nine places (`grep -n 'liveText(page)).toBe' tests/layout-drag.spec.ts`
//      — counted, not remembered; line numbers are not quoted here because
//      they move every time that file grows a case). Any visible chrome added
//      inside the region changes the string all nine compare against.
//
// The pill is `aria-hidden` for the mirror-image reason: assistive tech is
// already being told, by the region, in its own words. Announcing the same
// outcome from two elements is the duplicate-message bug, pointed the other way.
//
// This is deliberately not a toast SYSTEM. PRODUCT.md's first principle is
// "density over decoration — every pixel should carry information or
// structure", and there is exactly ONE message type in the whole app that needs
// to be said this way. A context, a portal and a queue would be an order of
// magnitude more code than one ref-driven div, for a generality nothing has
// asked for. If a second message type ever appears, that is the moment to build
// the system — not before.
const SAVE_PILL_BASE =
  'pointer-events-none fixed bottom-4 right-4 z-[150] rounded-control border px-3 py-1.5 text-note font-semibold'
// `hidden`, not `opacity-0`: an empty bordered box is still a painted box.
const SAVE_PILL_HIDDEN = `${SAVE_PILL_BASE} hidden`
const SAVE_PILL_OK = `${SAVE_PILL_BASE} border-[var(--pill-ok-fg)] bg-[var(--pill-ok-bg)] text-[var(--pill-ok-fg)]`
const SAVE_PILL_FAIL = `${SAVE_PILL_BASE} border-[var(--pill-crit-fg)] bg-[var(--pill-crit-bg)] text-[var(--pill-crit-fg)]`
const SAVE_PILL_MS = 2500

// The words. Short enough to read at a glance on success, because the operator
// already saw the panel move and only needs confirming; explicit about the
// CONSEQUENCE on failure, because "Save failed" tells somebody who does not
// know what a POST is precisely nothing about what to do next.
const SAVE_PILL_OK_TEXT = 'Saved'
const SAVE_PILL_FAIL_TEXT = 'Could not save — your change is only on this screen.'

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
  // The VISIBLE half of "your change was written", and the timer that takes it
  // away again. See SAVE_PILL_* below for why this is a second element rather
  // than the live region, and why neither of them is React state.
  const toastRef = useRef(null)
  const toastTimerRef = useRef(null)
  // Which save is allowed to speak. See ctx.apply.
  const saveSeqRef = useRef(0)
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

  // ---- "Arrange panels": open/closed, and where focus goes when it closes ----
  //
  // The trigger button survives the popup (the strip keeps rendering behind
  // it), so focus return is a plain re-focus once the dialog has unmounted —
  // hence an effect rather than a call inside the close handler, which would
  // aim at a button while the dialog still held focus.
  const [arrangeOpen, setArrangeOpen] = useState(false)
  const arrangeBtnRef = useRef(null)
  const arrangeWasOpen = useRef(false)
  useEffect(() => {
    if (arrangeOpen) {
      arrangeWasOpen.current = true
      return
    }
    if (!arrangeWasOpen.current) return
    arrangeWasOpen.current = false
    arrangeBtnRef.current?.focus()
  }, [arrangeOpen])

  // ---- the names of the tiles, so the "bring it back" strip has words ----
  //
  // A hidden Card renders null, so its title JSX never runs and nothing in the
  // grid's own DOM says what the tile was called. The Card therefore hands its
  // title UP, in an effect that runs before it returns null, and this is where
  // it is kept.
  //
  // A ref plus a counter rather than plain state, because this is written by
  // every Card on the tab on mount: state would be a re-render per panel,
  // where the counter only moves when a name actually changed, and titles do
  // not change after the first paint. The counter is still needed — on a
  // reload, `hidden` arrives from the server before any Card has registered,
  // so the strip's first render has no names at all and has to be told when
  // they land, or it would sit on the raw panel ids until something else
  // happened to re-render the grid.
  const titlesRef = useRef(new Map())
  const [, bumpTitles] = useState(0)

  // ---- can this grid be rearranged at all? ----
  //
  // WHY THIS EXISTS. Reordering needs somewhere to reorder TO. #editor renders
  // exactly one panel (editor-object-form) and always will, and on that tab the
  // ⠿ handle had nowhere to drag to, move mode's arrow keys moved nothing, and
  // the generated help sentence below still told the operator "You can move
  // this panel" — a claim the tab could not honour. Resize and hide are not
  // affected: both do real work on a one-panel grid, so both stay exactly as
  // they were.
  //
  // Counted from the React children rather than the DOM, for two reasons: it is
  // right on the FIRST render (a DOM count would be a frame late, and reading
  // it in an effect would be another render), and a hidden tile has no element
  // to count — `hidden` only exists in state. Children with no panelId are not
  // panels: that is what excludes hiddenPanelGroup's "N panels hidden" row,
  // which carries no id and is not something anyone can move.
  //
  // Recomputed whenever the children or the layout change, because the count is
  // not static: #drift shows one panel until a drift check runs and two
  // afterwards, and hiding one of two panels takes a grid back down to one.
  const reorderable = useMemo(() => {
    if (!layoutKey) return false
    const hidden = new Set(layout?.hidden ?? [])
    let visible = 0
    for (const child of Children.toArray(children)) {
      const id = child?.props?.panelId
      if (id && !hidden.has(id)) visible++
      if (visible >= 2) return true
    }
    return false
  }, [children, layout, layoutKey])

  const schedule = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (ref.current) applyLayout(ref.current, itemsRef.current, overridesRef.current)
    })
  }, [])

  // showSavePill — the one writer of the visible pill. Written to the DOM by
  // hand, exactly as announce() below is and for exactly the same reason: this
  // fires at the end of a drag, and a setState here would re-render the grid
  // the gesture just finished measuring. That is the loop the whole layout
  // feature is built to stay out of, and it is why there is no `savedMessage`
  // state anywhere in this file.
  //
  // The timer lives in a ref so a second save inside 2.5s replaces the first
  // message instead of stacking two timers that each clear it.
  const showSavePill = useCallback((text, tone) => {
    const el = toastRef.current
    if (!el) return
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    el.textContent = text
    el.className = tone === 'fail' ? SAVE_PILL_FAIL : SAVE_PILL_OK
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      if (!toastRef.current) return
      toastRef.current.textContent = ''
      toastRef.current.className = SAVE_PILL_HIDDEN
    }, SAVE_PILL_MS)
  }, [])

  // sayVerdict — the save outcome, APPENDED to the live region rather than
  // written over it, and that is not a style choice.
  //
  // Every gesture calls ctx.apply(next, true) and then ctx.announce("Moved to
  // position 3 of 7") synchronously, so the save always resolves after the
  // gesture has already said what it did. Replacing would therefore delete the
  // only sentence that names WHAT moved and WHERE — the message the operator
  // actually asked for — and leave a bare "Layout saved" behind. Both facts
  // matter, they are about the same action, and `aria-atomic="true"` means the
  // region is re-read whole, so one sentence carrying both is what a screen
  // reader wants anyway.
  //
  // The trailing full stop is normalised because the announcements disagree
  // about it: "Moved to position 3 of 7" has none, "Layout is back where it
  // started." does.
  const sayVerdict = useCallback((text) => {
    const el = liveRef.current
    if (!el) return
    const said = (el.textContent ?? '').trim()
    el.textContent = said ? `${said.replace(/\.?$/, '.')} ${text}` : text
  }, [])

  // A tab switch unmounts the grid mid-timer. Without this the callback fires
  // against a detached node — harmless today, but it is also the shape that
  // leaks a timer per tab change for the life of the session.
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    },
    [],
  )

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
      // The second switch, and only the move gesture hangs off it: true only
      // while this grid actually shows two or more panels. See the comment at
      // its computation above — a one-panel grid can be resized and hidden, but
      // it cannot be rearranged, and it must not say that it can.
      reorderable,
      // Read by Card to find its own saved span. undefined when no layout is
      // loaded, which is what makes every Card's override path a no-op.
      spans: layout?.spans,
      // The tiles the operator has taken off this page. undefined until a
      // layout loads, so a tab with nothing saved renders every panel exactly
      // as it did before this existed.
      hidden: layout?.hidden,
      // Card calls this before it can return null, so the strip below the grid
      // can name a tile that is no longer rendering anything. Only a plain
      // string is kept: a title can be a React node (Overview's DNS hero
      // passes a clickable <span>), and there is no honest way to print one as
      // a line of text — the panel id is a worse name but a true one.
      //
      // Card resolves `panelName ?? title` before it calls this, so a panel
      // that draws no heading (or draws a React node instead of one) can still
      // hand up words. The panelId fallback below stays as the LAST resort, so
      // a panel can never drop out of the popup entirely — it is just no longer
      // the first thing a titleless panel gets. See Card's `panelName` prop.
      registerTitle(id, title) {
        // Nothing to name on an unmanaged grid: there is no strip, nothing can
        // be hidden, and a tab that has not been wired must not pick up a
        // re-render it never used to do.
        if (!layoutKey || !id) return
        const name = typeof title === 'string' && title.trim() !== '' ? title : null
        if (titlesRef.current.get(id) === name) return
        titlesRef.current.set(id, name)
        bumpTitles((n) => n + 1)
      },
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
      //
      // `hidden` is the one part that CANNOT come from the DOM, and not as a
      // matter of taste: a hidden tile renders null, so there is no element to
      // read it off. Reading the DOM for it would answer "nothing is hidden"
      // every single time, and the first drag after hiding a tile would save
      // that answer over the truth. It comes from React state instead.
      snapshot() {
        const grid = ref.current
        return {
          order: grid ? panelItems(grid).map((entry) => entry.id) : [],
          spans: { ...(layout?.spans ?? {}) },
          hidden: [...(layout?.hidden ?? [])],
        }
      },
      // The single commit path. Pointer drop, pointer resize and keyboard
      // move mode all land here, so all three are validated by the same
      // schema — saveLayout throws on anything validateSave rejects, before
      // it reaches the network. `save: false` is the keyboard preview: the
      // layout moves on screen but nothing is written until Enter.
      //
      // AND THE SINGLE PLACE THE OUTCOME IS REPORTED. Until 2026-08-10 this
      // had a `.catch` and no `.then`, and saveLayout resolved `false` on a
      // non-ok response — so a 500 was silent in every channel at once. Both
      // halves are fixed: saveLayout throws (lib/layout.js), and both arms are
      // handled here.
      apply(next, save) {
        setLayout(next)
        if (save && layoutKey) {
          // THE SEQUENCE GUARD, AND IT IS THE ONE REAL HAZARD IN THIS FILE.
          // Two gestures in a row put two POSTs in flight and nothing orders
          // the responses. Without this, a slow FIRST save resolving after a
          // fast second one would write its verdict over the newer one's — so
          // a page whose latest save was rejected could sit there reading
          // "Saved". Only the newest save may write a message; an older one
          // that comes home late is dropped, because its verdict is no longer
          // about what is on screen.
          const seq = ++saveSeqRef.current
          saveLayout(layoutKey, next)
            .then(() => {
              // Set on the success arm and outside the sequence guard on
              // purpose. The guard exists to stop a stale save writing a
              // MESSAGE about the current screen; "this reader has rearranged
              // something and it saved" is true whichever save proved it, and
              // an older one proving it first is not a stale verdict.
              markArranged()
              if (seq !== saveSeqRef.current) return
              sayVerdict('Layout saved')
              showSavePill(SAVE_PILL_OK_TEXT, 'ok')
            })
            .catch((err) => {
              // Logged whether or not this save is still the newest: a stale
              // failure is still a real failure and still worth a console line.
              console.error('layout save failed', err)
              if (seq !== saveSeqRef.current) return
              sayVerdict('Layout could not be saved')
              showSavePill(SAVE_PILL_FAIL_TEXT, 'fail')
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
    [schedule, sayVerdict, showSavePill, layout, layoutKey, moveId, reorderable],
  )

  // A move that has run out of things to move. If the grid drops to one visible
  // panel WHILE move mode is running — the operator hides the other one, or a
  // data-driven tab loses a panel under them — the handle stops rendering and
  // the gesture would be left half-open: no key can reach it, nothing can
  // commit or cancel it, and the grid would still be holding the pre-move
  // layout it restores on Escape.
  //
  // Cancelled rather than committed, exactly as Escape and a real blur do:
  // arrow presses apply with save:false and only Enter POSTs, so nothing was
  // written and putting the pre-move state back is the only outcome that leaves
  // the screen and the server agreeing. endMove clears moveId, so this runs
  // once.
  useEffect(() => {
    if (!moveId || reorderable) return
    ctx.endMove(false)
    ctx.announce('Move cancelled: there is only one panel on this page, so there is nowhere to move it.')
  }, [ctx, moveId, reorderable])

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

  // ---- the wrapped-panel / layoutKey landmine, made loud ----
  //
  // snapshot() reads panel ids off the DOM, where a wrapped Card is visible;
  // sortByOrder reads props.panelId off the React children, where a wrapper
  // that does not carry one ranks last. A tab in that shape saves an order it
  // cannot honour and pushes the wrapped panel to the end on reload.
  //
  // The service-ownership wrapper was the loudest way to end up here, and no
  // longer is: `hiddenPanelGroup()` (below) is a plain function returning an
  // ARRAY, so each Card is a direct child of this grid again. What is left is
  // the ordinary mistake — a panel whose call site renders <SomePanel …/> with
  // the panelId literal buried on the <Card> inside it, or a plain <div>
  // carrying the span class. Overview shows the shape that works: the id goes
  // on the direct child (`<DnsHero panelId="dns-hero" …/>`) and is forwarded
  // down to the Card.
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

  // ---- the way back for a tile that has been put away ----
  //
  // Whatever is hidden, named, with a button each. The panel id is the fallback
  // name, and it is a poor one on purpose: it is at least true, where guessing
  // a title from an id would not be.
  const nameOf = (id) => titlesRef.current.get(id) || id
  const hiddenTiles = (layout?.hidden ?? []).map((id) => ({ id, name: nameOf(id) }))

  // What "On this page" lists, in the order the page is actually in.
  //
  // Read off `ordered` — the very array the grid renders — rather than off
  // `layout.order`, because the saved order can name panels this tab no longer
  // has and can omit panels added since the save. sortByOrder has already
  // resolved both, so this list and the DOM cannot disagree.
  //
  // A tile the operator has taken off the page is filtered out and given NO
  // rank here. `order` and `hidden` are separate fields in the saved blob, so
  // interleaving a hidden tile into this list would let the popup write a saved
  // state that dragging can never produce.
  const arrangeItems = useMemo(() => {
    if (!layoutKey) return []
    const hidden = new Set(layout?.hidden ?? [])
    const out = []
    for (const child of Children.toArray(ordered)) {
      const id = child?.props?.panelId
      if (id && !hidden.has(id)) out.push(id)
    }
    return out
  }, [ordered, layout, layoutKey])

  // Every button in the popup lands in one of the three helpers below, and all
  // three end at ctx.apply(next, true) — the identical path the drag, the
  // resize and keyboard move mode already use. There is no draft copy of the
  // order held anywhere in the popup, which is what makes "the popup and the
  // grid can never disagree" a property of the wiring rather than a promise.
  const showTile = (ids) => {
    const snap = ctx.snapshot()
    const gone = new Set(ids)
    ctx.apply({ order: snap.order, spans: snap.spans, hidden: snap.hidden.filter((id) => !gone.has(id)) }, true)
    // Named, not counted: "1 tile shown" says nothing about which one came
    // back, and the panel appears at the end of the page rather than where it
    // was, so a screen-reader user needs to be told what to look for.
    ctx.announce(
      ids.length === 1
        ? `${nameOf(ids[0])} is back on the page.`
        : `${ids.length} tiles are back on the page.`,
    )
  }

  const takeOffPage = (id) => {
    const snap = ctx.snapshot()
    if (snap.hidden.includes(id)) return
    ctx.apply({ order: snap.order, spans: snap.spans, hidden: [...snap.hidden, id] }, true)
    ctx.announce(`${nameOf(id)} is off the page. The Arrange panels button puts it back.`)
  }

  // shiftItem, not arithmetic written a second time. "One position up" in a
  // list the drag also edits is exactly the sum lib/layout.js already owns, and
  // a second copy of it here is a second chance to get the off-by-one wrong.
  const movePanel = (id, delta) => {
    const snap = ctx.snapshot()
    const next = shiftItem(snap.order, id, delta)
    // shiftItem hands back the SAME array when nothing moved, so a disabled
    // button that somehow fired announces nothing and saves nothing.
    if (next === snap.order) return
    ctx.apply({ order: next, spans: snap.spans, hidden: snap.hidden }, true)
    ctx.announce(
      `Moved ${nameOf(id)} ${delta < 0 ? 'up' : 'down'} to position ${next.indexOf(id) + 1} of ${next.length}.`,
    )
  }

  // The pointer drop inside the popup, and the same rule as movePanel above: no
  // arithmetic is written here. `to` arrives as an insertionIndex — a slot
  // counted against the list that still CONTAINS the dragged row — and moveItem
  // is the one function that knows a rightward/downward drop has to lose one
  // once the row is pulled out. Writing that subtraction a second time in this
  // file is exactly the off-by-one moveItem's comment is about.
  //
  // Same commit path as every button in the popup: ctx.apply(next, true). No
  // draft list, no Save button, so the popup still cannot drift from the grid.
  const dropPanel = (id, to) => {
    const snap = ctx.snapshot()
    const from = snap.order.indexOf(id)
    if (from < 0) return
    const next = moveItem(snap.order, from, to)
    // Both slots that mean "where it already was" collapse to no move (see
    // moveItem), so a drop that changed nothing announces nothing and saves
    // nothing — the same silence a disabled Move up button gives.
    if (next.indexOf(id) === from) return
    ctx.apply({ order: next, spans: snap.spans, hidden: snap.hidden }, true)
    ctx.announce(`Moved ${nameOf(id)} to position ${next.indexOf(id) + 1} of ${next.length}.`)
  }

  return (
    <GridFitContext.Provider value={ctx}>
      {/* ---- the way in, ABOVE the grid ----

          WHERE IT SITS IS THE WHOLE FIX. This strip used to render after the
          grid and only when something was hidden, so an operator who pressed ✕
          on a long tab was told the way back existed somewhere below seven
          panels they could not see, and on a tidy tab there was nothing to find
          at all. It now renders first, directly under the tab's heading, and it
          is there BEFORE anything is hidden — you cannot look for a control you
          have never seen.

          OUTSIDE the grid element, exactly like the live region below: a strip
          inside the grid would be a grid item, would take a track, and would be
          reordered by the very saved order it exists to edit.

          THE TESTID DID NOT CHANGE, and that is deliberate: it names the
          feature ("the operator's hidden tiles"), not the position, and the
          specs that already find the way back by this name should keep
          working across the move. It is still NOT "hidden-panels" — that name
          belongs to the service-ownership row further down this file, and
          tests/hidden-panels.spec.ts asserts an exact count of it.

          Rendered whenever this grid can be rearranged, and ALSO whenever
          something is off the page even if it cannot: hiding one of a two-panel
          tab's panels drops `reorderable` to false, and gating on that alone
          would take the only way back off screen at the moment it is needed. */}
      {layoutKey && (reorderable || hiddenTiles.length > 0) && (
        <div data-testid="hidden-tiles" className="mb-3 flex flex-wrap items-center gap-2 text-note text-muted">
          {/* One plain, worded button. Not an icon: the control that undoes
              "I pressed a ✕ and my panel vanished" cannot itself be a glyph
              the same operator has to decode. */}
          <button
            type="button"
            ref={arrangeBtnRef}
            data-layout-arrange=""
            aria-haspopup="dialog"
            aria-expanded={arrangeOpen}
            onClick={() => setArrangeOpen(true)}
            // LOUD ENOUGH TO BE FOUND, QUIET ENOUGH NOT TO BE THE PAGE'S MAIN
            // ACTION. It used to be text-muted inside a hairline border, which
            // is the exact treatment this file gives DISABLED chrome — an
            // operator scanning the page read straight past it.
            //
            // What changed, and why this and not something else: the accent
            // token already in the palette (--color-accent, #0070f3) carries
            // the border and a 15% wash behind the label, and the label itself
            // moves to full --color-txt at 12px semibold. Nothing here is a new
            // colour, a gradient, a shadow, an icon or an animation — the tint
            // and the border are doing the work, and the words stay words.
            //
            // It stays SECOND to "+ Provision" in the top bar by one deliberate
            // step: that button is a SOLID accent fill with white text, this one
            // is the tonal version of the same accent. Filled beats tinted at a
            // glance, which is the ranking a page control should have against
            // the page's primary action.
            className="cursor-pointer rounded-control border border-accent bg-accent/15 px-2.5 py-1 text-note font-semibold text-txt hover:bg-accent/25 hover:border-accent"
          >
            Arrange panels
          </button>
          {/* Only when there is something to say. A permanent "0 tiles are off
              the page." is a line of chrome that never changes and so is never
              read. */}
          {hiddenTiles.length > 0 && (
            <span>
              {hiddenTiles.length === 1
                ? '1 tile is off the page.'
                : `${hiddenTiles.length} tiles are off the page.`}
            </span>
          )}
        </div>
      )}
      <div ref={ref} data-card-grid="" className={`grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-[var(--sp-grid-gap)] ${className}`}>
        {ordered}
      </div>
      {/* The popup, also outside the grid element and for the same reason. It
          is position:fixed, so where it sits in this tree costs no layout. */}
      {arrangeOpen && (
        <ArrangeDialog
          items={arrangeItems}
          hiddenTiles={hiddenTiles}
          nameOf={nameOf}
          onMove={movePanel}
          onDrop={dropPanel}
          onTakeOff={takeOffPage}
          onPutBack={(id) => showTile([id])}
          onClose={() => setArrangeOpen(false)}
        />
      )}
      {/* One live region per managed grid, and one save pill — both OUTSIDE the
          grid element so neither is ever a grid item that could take a track.
          Rendered only when layoutKey is set, so an unmanaged tab's DOM is
          unchanged down to the element count. The two say the same news to two
          different audiences; SAVE_PILL_BASE's comment is why that is two
          elements and not one. */}
      {layoutKey && (
        <>
          <div ref={liveRef} data-layout-live="" aria-live="polite" aria-atomic="true" className="sr-only" />
          <div ref={toastRef} data-layout-toast="" aria-hidden="true" className={SAVE_PILL_HIDDEN} />
        </>
      )}
    </GridFitContext.Provider>
  )
}

// Everything that can hold focus inside the popup, in document order. Read
// fresh on every Tab, exactly as HeaderHelp and TenantManager do: this list
// changes with every button press here — taking a tile off the page moves a row
// from one section to the other — so a list captured on open would describe a
// dialog that is no longer on screen.
const ARRANGE_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// The sentences that explain reorder, resize, hide and auto-save. They live
// here rather than in panelHelp.js because they are facts about the LAYOUT
// SYSTEM, not about a panel: which grids are managed can change, and 96
// hand-copied sentences would go stale the moment one did. Still ONE string in
// ONE place, still generated from the same truth — only the place it is read
// has moved.
//
// SAID ONCE PER PAGE, NOT ONCE PER PANEL. Until 2026-08-09 Card appended these
// to EVERY managed panel's help, so the same ~60 words printed 83 times on a
// tab, under text that was otherwise about that one panel. Reported as "dont
// need that every time". They now render only inside the "Arrange this page"
// window — where somebody is standing precisely when they want to know how
// arranging works — folded into the footer line that already said changes save
// themselves, so the window gains one paragraph rather than stacking two.
//
// TWO PARTS, BECAUSE THEY ARE NOT TRUE OF THE SAME PAGES. Moving needs another
// panel to move past; resizing, auto-save and hiding do not. #editor renders
// one panel and always will, so on that tab the move sentence was describing a
// gesture the operator could not perform — and the ⠿ handle it names is not
// rendered there either. The gate is `items.length > 1`, which is the same
// count CardGrid's `reorderable` uses (arrangeItems is the order minus the
// hidden tiles) AND the same one that decides whether the rows in this window
// are draggable at all, so the copy and the chrome cannot disagree.
const LAYOUT_HELP_MOVE =
  'Drag a row up or down to change the order, or use the buttons. On the page ' +
  'itself you can drag a panel by its ⠿ grip.'

const LAYOUT_HELP_REST =
  'Drag a panel’s right edge to make it wider or narrower. The ✕ on a panel ' +
  'takes it off the page, and the list here puts it back at the end. Changes here save ' +
  'right away — there is no Save button.'

// ---------- "Arrange this page" ----------
//
// A VIEW OF THE GRID'S STATE, NEVER A COPY OF IT. Every button here calls
// straight back into CardGrid's helpers, which call ctx.apply(next, true) —
// the one commit path. There is no draft order in this component, no Save
// button and no second place that writes, so the popup cannot drift from the
// page behind it and there is nothing to reconcile when it closes.
//
// THE MODAL MACHINERY IS COPIED FROM HeaderHelp.jsx, NOT INVENTED. Dialog role,
// focus onto the panel rather than onto its first button, a Tab trap re-read on
// every press, Escape stopped so it cannot also reach App.jsx's document-level
// Escape (which belongs to the nav menus). That file's own comment says a
// second, subtly different dialog is the version that rots, so this one follows
// it line for line.
//
// ONE DELIBERATE DIFFERENCE: HeaderHelp's background is made `inert` by
// App.jsx, which owns the flag. This dialog is opened from inside the tab
// content that App.jsx's inert wrapper contains, so it cannot set that flag on
// its own ancestor without editing App.jsx. The Tab trap below is what holds
// focus instead — stated rather than left as a silent gap.
//
// FOCUS RETURN is owned here rather than by the caller, because unlike
// HeaderHelp this component's trigger button stays mounted the whole time: the
// strip keeps rendering behind the popup, so the button is still there to
// receive focus when the popup goes.
function ArrangeDialog({ items, hiddenTiles, nameOf, onMove, onDrop, onTakeOff, onPutBack, onClose }) {
  const panelRef = useRef(null)

  // Focus goes to the panel, not to its ✕: what a screen reader then reads is
  // the dialog and its name, rather than "Close button" with no idea what would
  // be closed. Same choice, same reason, as the settings sheet.
  useEffect(() => { panelRef.current?.focus() }, [])

  // WHERE FOCUS GOES AFTER A BUTTON DOES ITS JOB. Every action here re-orders
  // or re-sections the rows, and React moving a focused node between parents
  // drops focus to <body> — which would dump a keyboard user out of the popup
  // mid-task, once per press. So each handler names the control it wants focus
  // on afterwards, and this effect puts it there once the new rows exist.
  // The fallback matters: Move up on the row that just reached the top leaves
  // its own button disabled, so focus lands on that row's Move down instead.
  const refocusRef = useRef(null)
  useEffect(() => {
    const wanted = refocusRef.current
    if (!wanted) return
    refocusRef.current = null
    const panel = panelRef.current
    if (!panel) return
    for (const sel of wanted) {
      if (!sel) continue
      const el = panel.querySelector(sel)
      if (el && !el.disabled) {
        el.focus()
        return
      }
    }
    panel.focus()
  })

  const act = (run, ...refocus) => {
    refocusRef.current = refocus
    run()
  }

  // ---- drag a row to a new position ----
  //
  // WHY THE BUTTONS STAYED. Dragging is the fast way for a pointer; it is no
  // way at all for a keyboard, a screen reader or a shaky hand. Move up / Move
  // down are still the whole feature for those, so this is added ALONGSIDE
  // them and neither route knows about the other — both end at the grid's one
  // ctx.apply(next, true).
  //
  // ONLY THE ORDERED SECTION IS DRAGGABLE. The rows under "Off this page" get
  // no handler and no [data-arrange-row], so there is no gesture that can put a
  // hidden tile into the ranked list. `order` and `layout.hidden` are separate
  // fields in the saved blob, and a hidden tile with a rank is a state the grid
  // itself can never produce.
  const dragCancelRef = useRef(null)
  // A drag released over the backdrop would otherwise fire a click there and
  // close the window on the operator mid-task. Cleared on the next task, i.e.
  // after that click has been and gone.
  const swallowClickRef = useRef(false)
  const [dragId, setDragId] = useState(null)

  // A drag left running when the popup unmounts — Escape, or the tab changing
  // under it — must not leave its insertion line behind on <body>.
  useEffect(() => () => dragCancelRef.current?.(), [])

  // WHICH SLOT THE POINTER IS ASKING FOR, and the reason there is no counting
  // loop here. insertionIndex (lib/layout.js) already answers exactly this
  // question for the grid, where the items sit side by side; this list is the
  // same problem rotated 90°, so the rects are handed to it TRANSPOSED — each
  // row's top/bottom goes in as left/right, and the pointer's y goes in as x.
  // Every rect then falls into its "these two are on the same row, so the
  // midpoint decides" branch, which is precisely the rule a single column
  // needs: count the rows whose middle the pointer has passed.
  const rowSlot = (rects, y) =>
    insertionIndex(rects.map((r) => ({ top: 0, bottom: 0, left: r.top, right: r.bottom })), y, 0)

  const onRowPointerDown = (e, id) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // A press on one of the row's own buttons is a click on that button.
    if (e.target.closest('button')) return
    // Keeps the press from blurring whatever inside the dialog currently holds
    // focus. Without it, focus falls to <body> and the Tab trap below — which
    // reasons about first/last — has nothing sensible to trap.
    e.preventDefault()

    const rowEl = e.currentTarget
    const startY = e.clientY
    let started = false
    let line = null
    let target = 0
    const ac = new AbortController()
    const { signal } = ac

    // Re-read on every move rather than cached at the start: the popup is
    // scrollable, and a stale rect aims the drop at the wrong slot.
    const rowRects = () =>
      [...(panelRef.current?.querySelectorAll('[data-arrange-row]') ?? [])].map((el) =>
        el.getBoundingClientRect(),
      )

    const begin = () => {
      started = true
      setDragId(id)
      // z-index 210 clears the dialog's own z-[200]; overlayEl writes 60 first
      // and the later declaration in the same inline style wins.
      line = overlayEl(
        'data-arrange-insert-line',
        'height:3px;border-radius:2px;background:var(--color-accent);z-index:210;',
      )
      document.body.style.userSelect = 'none'
      dragCancelRef.current = () => finish(false)
    }

    const placeLine = (idx, rects) => {
      if (!rects.length) return
      const last = idx >= rects.length
      const r = rects[last ? rects.length - 1 : idx]
      line.style.left = `${r.left}px`
      line.style.width = `${r.width}px`
      line.style.top = `${(last ? r.bottom : r.top) - 1}px`
    }

    function finish(commit) {
      ac.abort()
      dragCancelRef.current = null
      if (line) line.remove()
      document.body.style.userSelect = ''
      if (!started) return
      setDragId(null)
      swallowClickRef.current = true
      setTimeout(() => { swallowClickRef.current = false }, 0)
      if (!commit) return
      // Through act(), exactly as every button here does: the rows re-sort
      // under the drop, and naming where focus should land afterwards is what
      // keeps a keyboard user inside the window.
      act(() => onDrop(id, target), `[data-arrange="up:${id}"]`, `[data-arrange="down:${id}"]`)
    }

    rowEl.addEventListener(
      'pointermove',
      (ev) => {
        if (!started) {
          // Below the threshold this is still a press, not a drag.
          if (Math.abs(ev.clientY - startY) < 4) return
          begin()
        }
        const rects = rowRects()
        target = rowSlot(rects, ev.clientY)
        placeLine(target, rects)
      },
      { signal },
    )
    rowEl.addEventListener('pointerup', () => finish(true), { signal })
    rowEl.addEventListener('pointercancel', () => finish(false), { signal })
    try {
      rowEl.setPointerCapture(e.pointerId)
    } catch {
      // Best-effort, as everywhere else in this file: the listeners work without it.
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      // A drag still in flight is abandoned rather than committed, the same way
      // Escape abandons a keyboard move: nothing was saved on the way here.
      dragCancelRef.current?.()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const focusable = [...panelRef.current.querySelectorAll(ARRANGE_FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!focusable.length) {
      e.preventDefault()
      panelRef.current.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const cur = document.activeElement
    if (e.shiftKey && (cur === first || cur === panelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const rowBtn =
    'cursor-pointer rounded-control border border-border px-1.5 py-0.5 text-note leading-none text-muted hover:text-field-txt hover:border-border-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted disabled:hover:border-border'

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4"
      // Clicking the backdrop closes the window — unless the "click" is the
      // tail of a drag that happened to be released out here, which is a move,
      // not a dismissal.
      onClick={() => { if (!swallowClickRef.current) onClose() }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="arrange-title"
        data-arrange-dialog=""
        tabIndex={-1}
        className="w-[460px] max-w-full max-h-[80vh] overflow-y-auto bg-card border border-card-border rounded-surface p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-4">
          <h2 id="arrange-title" className="text-copy font-semibold">Arrange this page</h2>
          <span className="flex-1" />
          <button type="button" className="text-muted text-copy cursor-pointer" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <h3 className="text-note font-semibold text-field-txt mb-1.5">On this page</h3>
        {items.length === 0 ? (
          <p className="m-0 mb-4 text-note text-muted">Every panel is off the page right now.</p>
        ) : (
          <ul className="m-0 mb-4 list-none p-0">
            {items.map((id, i) => (
              // A list of one has nowhere to drag to, so it gets no grip, no
              // grab cursor and no handler — the same rule the grid's own ⠿
              // handle follows on a one-panel tab, and for the same reason: an
              // affordance for a gesture that cannot do anything is a lie.
              <li
                key={id}
                {...(items.length > 1
                  ? { 'data-arrange-row': id, onPointerDown: (e) => onRowPointerDown(e, id) }
                  : null)}
                className={`flex items-center gap-1.5 py-1 border-b border-line-2 last:border-b-0 ${
                  items.length > 1 ? 'cursor-grab' : ''
                } ${dragId === id ? 'opacity-40' : ''}`}
              >
                {/* The affordance, and it is only that — the row itself is the
                    drag surface, so nobody has to hit a 10px target to move a
                    panel. Hidden from assistive tech: it names no action a
                    keyboard user can take, and the two Move buttons beside it
                    do. */}
                {items.length > 1 && (
                  <span aria-hidden="true" className="select-none text-dim text-note leading-none">⠿</span>
                )}
                <span data-arrange-name="" className="flex-1 min-w-0 truncate text-note text-field-txt">{nameOf(id)}</span>
                {/* DISABLED, never missing. A button that vanishes at the top
                    of the list moves every other button under the pointer and
                    out from under the keyboard, and gives no answer to "why
                    can't I move this one up". */}
                <button
                  type="button"
                  data-arrange={`up:${id}`}
                  disabled={i === 0}
                  // Every row's button says the same two words, so the name a
                  // screen reader or a voice-control user gets has to carry the
                  // panel. It STARTS with the visible words, which is what keeps
                  // WCAG 2.5.3 Label in Name true and "click Move up" working.
                  aria-label={`Move up: ${nameOf(id)}`}
                  onClick={() => act(() => onMove(id, -1), `[data-arrange="up:${id}"]`, `[data-arrange="down:${id}"]`)}
                  className={rowBtn}
                >
                  Move up
                </button>
                <button
                  type="button"
                  data-arrange={`down:${id}`}
                  disabled={i === items.length - 1}
                  aria-label={`Move down: ${nameOf(id)}`}
                  onClick={() => act(() => onMove(id, 1), `[data-arrange="down:${id}"]`, `[data-arrange="up:${id}"]`)}
                  className={rowBtn}
                >
                  Move down
                </button>
                <button
                  type="button"
                  data-arrange={`off:${id}`}
                  aria-label={`Take off the page: ${nameOf(id)}`}
                  onClick={() => act(() => onTakeOff(id), `[data-arrange="back:${id}"]`)}
                  className={rowBtn}
                >
                  Take off the page
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Only when there is something off the page. An empty "Off this page"
            heading on every tidy tab is a section that says nothing. */}
        {hiddenTiles.length > 0 && (
          <>
            <h3 className="text-note font-semibold text-field-txt mb-1.5">Off this page</h3>
            <ul className="m-0 mb-4 list-none p-0">
              {hiddenTiles.map((tile) => (
                <li key={tile.id} className="flex items-center gap-1.5 py-1 border-b border-line-2 last:border-b-0">
                  <span data-arrange-name="" className="flex-1 min-w-0 truncate text-note text-field-txt">{tile.name}</span>
                  <button
                    type="button"
                    data-arrange={`back:${tile.id}`}
                    aria-label={`Put back on the page: ${tile.name}`}
                    onClick={() => act(() => onPutBack(tile.id), `[data-arrange="off:${tile.id}"]`)}
                    className={rowBtn}
                  >
                    Put back on the page
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* THE ONE PLACE THE LAYOUT SYSTEM IS EXPLAINED. Says the drag exists,
            because a ⠿ on a row does not say it to anyone who has not already
            met the pattern; says resize and hide, which are otherwise invisible
            (the resize hotspot is opacity-0 until hover); and says nothing
            needs saving. Generated from the same gate as the rows above, so a
            window listing one panel never promises a reorder. */}
        <p className="m-0 text-note text-muted">
          {items.length > 1 ? `${LAYOUT_HELP_MOVE} ${LAYOUT_HELP_REST}` : LAYOUT_HELP_REST}
        </p>
      </div>
    </div>
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
// (The sentences that explain reorder, resize, hide and auto-save used to be
// declared here and appended by Card to every managed panel's help. They now
// live above ArrangeDialog and are said once, in the window that button opens —
// see the comment there for why.)

// ---- the runtime half of the help guarantee ----
//
// panelHelp.test.js reads the JSX and catches every LITERAL panelId. What it
// cannot see is a computed one — `panelId={`dns-zone-${view}`}` produces an id
// no static scan can enumerate, and a Card built by a file outside tabs/ and
// components/ is not scanned at all. Those only exist at run time, so this is
// the check that runs there.
//
// NOT gated behind import.meta.env.DEV, for the reason spelled out at the
// wrapped-panel/layoutKey guard above: the dev server and the e2e harness both
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
    `[panel-help] panelId "${panelId}" has no entry in PANEL_HELP, so this panel's About ` +
      'button does not render. Add an entry to ui/src/lib/panelHelp.js.',
  )
}

// `panelId` is the stable identity a saved layout refers to. Explicit, never
// derived from the title: a title is copy, it gets reworded, and a layout
// keyed on it would silently detach from its panel the first time someone
// edited a heading. A Card without one is invisible to the layout system.
//
// `panelName` is WHAT THIS PANEL IS CALLED IN WORDS, and it renders nothing.
// The "Arrange this page" popup, the announcements, and the move/hide buttons'
// accessible names all have to name a panel in a sentence, and until this prop
// existed the only source was `title` — so the two Overview panels that draw no
// plain-string heading (the DNS hero, whose title is a clickable <span>, and the
// KPI stack, which has no title at all) were listed to a non-engineer as
// "dns-hero" and "kpi-stack". It is deliberately NOT the title: a panel can
// carry a heading that is a node, a heading that changes with a filter, or no
// heading at all, and all three still need one stable line of text. Setting it
// changes no element, no layout and no pixel on the card itself.
export function Card({ title, panelName, note, right, span = 2, panelId, fit: fitEnabled = true, className = '', innerRef, children }) {
  const spanClass = SPAN_CLASS[span] || SPAN_CLASS[6]
  const ref = useRef(null)
  const headRef = useRef(null)
  const titleRef = useRef(null)
  const noteRef = useRef(null)
  const rightRef = useRef(null)
  const headCanvasRef = useRef(null)
  const bodyNeedRef = useRef(null)
  const grid = useContext(GridFitContext)

  // A panel is rearrangeable only inside a grid that persists layouts AND only
  // if it has the stable identity a saved layout refers to. Both, or neither:
  // a handle on a panel with no panelId would move something nothing could
  // record.
  //
  // Declared up here, before the first effect, because `isHidden` gates what
  // those effects do — the same reason the early `return null` has to wait
  // until the very bottom of this component.
  const managed = !!(grid?.managed && panelId)
  // ...and it can only be MOVED if the grid it sits in currently shows another
  // panel to move it past. See CardGrid's `reorderable` for why: a one-panel
  // tab (#editor) grew a drag handle and a help sentence promising a move that
  // could not happen. Resize and hide are not gated on it — both work on a
  // one-panel grid.
  const reorderable = managed && !!grid.reorderable
  const isHidden = managed && !!grid.hidden?.includes(panelId)

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
    // A hidden tile renders null, so its element is gone from the DOM but this
    // component is still mounted — the unmount eviction below will never run
    // for it. Left registered, its stale entry would keep a row open in the
    // fit map for a panel nobody can see. remove() is the grid's own entry
    // point for exactly this, and it is called from here rather than by
    // teaching applyLayout or publish() about hiding: those two are the
    // measurement loop this feature is not allowed to re-enter.
    if (isHidden) {
      const evict = evictRef.current
      evictRef.current = null
      if (evict?.item) evict.grid.remove(evict.item)
      return
    }
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

  // Hand the panel's name up to the grid, so the "put it back" strip can list
  // this tile by what it is called after this Card has stopped rendering
  // anything. It has to happen in an effect that runs whether or not the
  // component returned null, which is why every hook in this file sits above
  // that early return.
  //
  // `panelName` first, then the title, then nothing — and registerTitle keeps
  // only a plain string, so a React-node title still falls through to the
  // panelId exactly as it did before this prop existed.
  useEffect(() => {
    grid?.registerTitle?.(panelId, panelName ?? title)
  }, [grid, panelId, panelName, title])

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
        grid.apply({ order: snap.order, spans: { ...snap.spans, [panelId]: span }, hidden: snap.hidden }, true)
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
  //
  // `panelName` wins here for the same reason it wins in registerTitle: it is
  // the one line of words the panel is guaranteed to have. Without it a
  // titleless panel announced "Moving kpi-stack" — the identical raw-id leak
  // the popup had, one layer down.
  const labelText = useCallback(
    () => panelName || (typeof title === 'string' ? title : titleRef.current?.textContent || panelId),
    [panelId, panelName, title],
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
        grid.apply({ order: next, spans: snap.spans, hidden: snap.hidden }, true)
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
        grid.apply({ order: next, spans: snap.spans, hidden: snap.hidden }, false)
        grid.announce(`Moved to position ${next.indexOf(panelId) + 1} of ${next.length}`)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = stepSpan(liveSpan(), e.key === 'ArrowUp' ? 1 : -1)
        grid.apply({ order: snap.order, spans: { ...snap.spans, [panelId]: next }, hidden: snap.hidden }, false)
        // The STORED span is `next`, unclamped on purpose (stepSpan's comment);
        // what gets rendered is that clamped to the tracks this breakpoint
        // actually has, and the announcement is about what renders.
        grid.announce(widthAnnouncement(next, grid.geometry()?.trackCount))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        grid.endMove(true, snap)
        // NO "Layout saved." HERE ANY MORE. This ran synchronously, before the
        // POST had even left, so on a rejected save it was a flat lie — and it
        // was the only path that claimed it, so the drag and the keyboard
        // disagreed about whether saving was worth mentioning. The verdict is
        // appended by ctx.apply when the server has actually answered, which
        // makes both paths say it and neither say it early.
        grid.announce(`${label} placed at position ${snap.order.indexOf(panelId) + 1} of ${snap.order.length}.`)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        grid.endMove(false)
        grid.announce(`Move cancelled. ${label} is back where it started.`)
      }
    },
    [grid, labelText, liveSpan, managed, moveActive, panelId],
  )

  const handle = reorderable ? (
    <button
      type="button"
      ref={handleRef}
      data-layout-handle=""
      // The panel's own words, so a screen reader announces which panel this
      // moves — never a bare "drag handle" repeated seven times down a tab.
      {...(title ? { 'aria-labelledby': `${moveWordId} ${titleId}` } : { 'aria-label': `Move ${panelName || panelId}` })}
      aria-pressed={moveActive}
      title="Drag to move, or press Enter to move with the arrow keys"
      onPointerDown={onHandleDown}
      onKeyDown={onHandleKey}
      onBlur={onHandleBlur}
      className={`shrink-0 cursor-grab touch-none select-none rounded-control border px-1.5 py-0.5 text-note leading-none inline-flex items-center justify-center min-w-6 min-h-6 ${
        moveActive ? 'border-accent text-accent' : 'border-border text-dim hover:text-field-txt hover:border-border-hover'
      }`}
    >
      {title && <span id={moveWordId} className="sr-only">Move</span>}
      ⠿
    </button>
  ) : null

  // ---- hide: take this tile off the page ----
  //
  // Same commit path as the drop and the resize — snapshot, add this panel to
  // the hidden list, apply and save — so hiding is validated by the one schema
  // on its way to the server and cannot write a shape the loader will reject.
  //
  // The order is left exactly as the DOM reports it, which still names this
  // panel: it is on screen at the moment of the click. Once it is gone the
  // next snapshot will not name it, so bringing it back puts it at the end of
  // the page. That is the same rule a panel added after a save already
  // follows, and it is stated in the "Arrange this page" window's footer
  // ("puts it back at the end") rather than papered over.
  const hideWordId = panelId ? `panel-hide-${panelId}` : undefined
  const onHide = useCallback(() => {
    const snap = grid.snapshot()
    if (snap.hidden.includes(panelId)) return
    grid.apply({ order: snap.order, spans: snap.spans, hidden: [...snap.hidden, panelId] }, true)
    grid.announce(`${labelText()} is off the page. The Arrange panels button at the top of the page puts it back.`)
  }, [grid, labelText, panelId])

  const hideBtn = managed ? (
    <button
      type="button"
      data-layout-hide=""
      // By reference when there is a title, by id when there is not — the same
      // shape as the handle above, and for the same reason: a title can be a
      // React node, and interpolating one gives "Hide [object Object]".
      {...(title ? { 'aria-labelledby': `${hideWordId} ${titleId}` } : { 'aria-label': `Hide ${panelName || panelId}` })}
      title="Hide this panel"
      onClick={onHide}
      className="shrink-0 cursor-pointer rounded-control border border-border px-1.5 py-0.5 text-note leading-none inline-flex items-center justify-center min-w-6 min-h-6 text-dim hover:text-field-txt hover:border-border-hover"
    >
      {title && <span id={hideWordId} className="sr-only">Hide</span>}
      ✕
    </button>
  ) : null

  // ---- the "About" panel-help disclosure ----
  //
  // THE CONTROL DRAWS AN ⓘ GLYPH. It said the word "About" for one release; the
  // reversal is the user's — "the i cirle is better than about". ONLY the
  // visible glyph changed back: it is the same <button> in the same slot, it
  // still carries data-panel-help-toggle, aria-expanded and aria-controls, and
  // its ACCESSIBLE NAME is still the words "About: <panel>" (the sr-only span
  // below), so a screen reader and voice control hear a name, never a symbol.
  // All three doors below are untouched.
  //
  // THREE DOORS, ONE RULE. Hover it with a mouse, or move the keyboard focus
  // onto it, and the help appears while that lasts. Click it (or press Enter or
  // Space) and the help is PINNED: it stays after the pointer leaves and after
  // the focus leaves, so a long entry can be read without holding the mouse
  // still. In one line: leaving closes it only if it was never clicked.
  // Clicking a pinned panel closes it and cancels the hover/focus preview you
  // are still inside — otherwise "click again to close" would be a lie, because
  // the pointer resting on the control (and the focus a click leaves behind)
  // would re-open it the instant it shut. Move away and come back and the
  // preview works again, because that is a fresh pointerenter/focus.
  //
  // Not a `title=` tooltip and not a floating layer. The disclosure stays a
  // block in normal flow under the header — the shape already proven here — for
  // the reason written above TabIntro at the bottom of this file: hover does not
  // exist on touch, so anything that ONLY hovers is unreadable on exactly the
  // devices a dashboard gets glanced at from. Hover is an addition to the click,
  // never a replacement for it. A native <button> keeps Enter, Space, focus and
  // the expanded/collapsed announcement free.
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
  // THE GLYPH COSTS LESS THAN THE WORD DID, MEASURED. While it drew "About" the
  // button was 45px; back as ⓘ it measures 24.83px in Chromium, identical at
  // 1920, 1280, 1024, 768 and 390. Re-running panel-help.spec.ts's sweep over
  // #security, #assets, #network and #dns at those five widths found ZERO
  // headings, buttons or open disclosures spilling past their card — including
  // assets-filter-bar and network-dhcp-leases at 390, which the word-era spec
  // had to exclude. That exclusion list is deleted, not carried forward, and
  // the spec now holds all four tabs at all five widths to zero.
  //
  // The BODY is a block BELOW the header and is invisible to both measurers:
  // headNeed reads only the title canvas and rightRef, bodyNeed is whatever
  // DataTable reported about its own table. The fit system is width-only, so
  // the height this adds costs nothing.
  //
  // The CONTAINER is rendered even while collapsed, with `hidden`, so
  // aria-controls always resolves. A reference to an element that does not
  // exist is the shape hiddenPanelGroup's row below already rejects.
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
  //
  // ADDING HOVER DID NOT RELAX THIS, and it is the one way this feature could
  // have brought the regression back. The obvious way to build a hover reveal —
  // render the text always and flip a CSS class — would put all 83 entries back
  // in the document on every tab, which is exactly the state that broke those
  // eight specs. So hover changes only WHEN `helpOpen` is true; it changes
  // nothing about what is mounted while it is false. panel-help.spec.ts asserts
  // that document.body.textContent does not contain a closed panel's sentence,
  // which fails the moment anyone renders it unconditionally.
  const help = panelId ? PANEL_HELP[panelId] : null
  // In an effect, not in the render body: React renders a component twice under
  // StrictMode and again on every fit pass, and an error thrown from render
  // ordering is harder to read than one attached to a mount.
  useEffect(() => {
    if (!help) reportMissingHelp(panelId, title)
  }, [help, panelId, title])
  // THREE PIECES OF STATE, ONE DERIVED ANSWER, because the three doors are not
  // the same kind of open. `pinned` is a decision the operator made and only
  // another click takes it back; `peek` and `focus` are previews that last
  // exactly as long as the pointer or the focus does. They are separate rather
  // than one counter so that a mouse leaving while the button still holds the
  // keyboard focus does NOT close it — each door closes only its own preview.
  const [helpPinned, setHelpPinned] = useState(false)
  const [helpPeek, setHelpPeek] = useState(false)
  const [helpFocus, setHelpFocus] = useState(false)
  const helpOpen = helpPinned || helpPeek || helpFocus
  const helpId = panelId ? `panel-help-${panelId}` : undefined
  const aboutWordId = panelId ? `panel-about-${panelId}` : undefined

  // Closing wins over both previews — see the rule in the block comment above.
  // A click leaves the focus ON this button and usually leaves the pointer on
  // it too, so unpinning without clearing them would shut the panel and reopen
  // it in the same frame.
  const toggleHelp = useCallback(() => {
    if (helpPinned) {
      setHelpPinned(false)
      setHelpPeek(false)
      setHelpFocus(false)
      return
    }
    setHelpPinned(true)
  }, [helpPinned])

  const infoBtn = help ? (
    <button
      type="button"
      data-panel-help-toggle=""
      // Labelled by REFERENCE for the same reason as the handle above: a title
      // can be a React node, and interpolating one into a template literal
      // gives the accessible name "About [object Object]". It also carries the
      // whole accessible name now that the visible content is a glyph again —
      // the sr-only "About:" span is the only text in the name, so nothing
      // reads out "circled latin small letter i".
      {...(title ? { 'aria-labelledby': `${aboutWordId} ${titleId}` } : { 'aria-label': `About ${panelId}` })}
      aria-expanded={helpOpen}
      aria-controls={helpId}
      onClick={toggleHelp}
      // pointerenter, guarded on pointerType, rather than mouseenter: a tap on a
      // touchscreen synthesises mouse events, so mouseenter would "hover" a
      // panel open on the same tap that clicks it and then leave it stuck open
      // with no pointer to move away.
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHelpPeek(true) }}
      onPointerLeave={() => setHelpPeek(false)}
      // Focus, not focus-visible: a keyboard user must not have to press
      // anything to read the help, and this is also what makes the preview come
      // back after a close — blur clears it, the next focus sets it again.
      onFocus={() => setHelpFocus(true)}
      onBlur={() => setHelpFocus(false)}
      className={`shrink-0 cursor-pointer rounded-control border px-1.5 py-0.5 text-note leading-none inline-flex items-center justify-center min-w-6 min-h-6 ${
        // Hover does not fight the pinned state: pinned always wins the accent,
        // a preview gets the plain hover treatment, and the closed state keeps
        // the CSS :hover fallback for anything the JS previews miss.
        helpPinned
          ? 'border-accent text-accent'
          : helpOpen
            ? 'border-border-hover text-field-txt'
            : 'border-border text-dim hover:text-field-txt hover:border-border-hover'
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
      // FULL PANEL WIDTH, AND THE TRADE THAT BUYS. This used to carry
      // max-w-[80ch], the standard readability measure — past roughly 80
      // characters the eye loses its place jumping back to the start of the
      // next line. On a narrow panel that cap did nothing, because the panel
      // was already the narrower of the two; on a wide one it left an obvious
      // band of empty grey to the right of the text, which is what was
      // reported. Full width was asked for and is what is here, so on a
      // six-column panel these lines now run long — that is the cost, and it is
      // paid for a help block of two or three sentences that is read once, not
      // for body copy that is read for minutes.
      //
      // TabIntro (further down this file) keeps its 80ch cap: it is a permanent
      // line of page furniture under the tab heading, not a block the operator
      // opened on purpose, and nothing was reported about it.
      className="mb-2 rounded-control border border-line-2 bg-line px-2.5 py-2 text-note leading-relaxed text-muted"
    >
      {helpOpen && (
        <>
          {/* THIS PANEL, AND NOTHING ELSE. The layout sentences that used to be
              appended here are gone: the same ~60 words under all 83 panels
              said nothing about the panel the reader had just opened. They are
              said once instead, in the "Arrange this page" window. */}
          <p>{help.what}</p>
          {help.look && <p className="mt-1">{help.look}</p>}
        </>
      )}
    </div>
  ) : null

  // A hidden tile draws nothing at all — not a collapsed stub, not a
  // zero-height box. Anything left in the DOM would still be a grid item and
  // would still take a track, which is the opposite of what "hide this" asks
  // for, and find-in-page and text scrapers would keep reading its contents.
  //
  // LAST, after every hook above, because React counts hooks per render and a
  // component that runs eleven of them on one render and none on the next
  // crashes the tab. The component stays mounted while hidden; only its output
  // goes away, which is also what lets the effects above keep registering this
  // panel's name and evicting it from the fit map.
  if (isHidden) return null

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
      className={`relative bg-card border border-card-border rounded-surface p-[var(--sp-card-pad)] ${moveActive ? 'ring-2 ring-accent' : ''} ${spanClass} ${className}`}
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
          className="absolute top-0 right-0 h-full w-2 cursor-col-resize touch-none rounded-r-surface opacity-0 hover:opacity-100 focus-visible:opacity-100"
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
          <h2 id={titleId} ref={titleRef} className="text-copy font-semibold min-w-0 break-words">{title}</h2>
          {note && <span ref={noteRef} className="text-note text-dim min-w-0 break-words">{note}</span>}
          <span className="flex-1" />
          {/* The drag handle goes INSIDE the `right` slot, not beside it, and
              that placement is the whole reason headNeed keeps working: the
              floor under a panel's width is measured as title + gap +
              rightRef.scrollWidth, so a handle rendered as a sibling of this
              span would be a header element the measurement could not see —
              and the header would overflow the card by exactly the handle's
              width. Sitting inside rightRef, it is counted for free. */}
          {(right || infoBtn || handle || hideBtn) && (
            <span ref={rightRef} className="shrink-0 max-w-full flex flex-wrap items-center justify-end gap-2 [&_input]:min-w-0 [&_select]:min-w-0">
              {right}
              {infoBtn}
              {hideBtn}
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
      {!title && (infoBtn || handle || hideBtn) && (
        <span className="absolute top-2 right-3 z-10 flex items-center gap-1.5">
          {infoBtn}
          {hideBtn}
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
// Takes a contiguous run of grid children and either hands them back exactly as
// they were, or replaces the whole run with one compact row. Nothing about a
// shown panel changes: it stays a DIRECT child of the CardGrid and keeps its
// own span and content-fit measurement. That is why this works at the Card
// boundary and never reaches inside a panel's own state machine — the two tabs
// it is applied to are the biggest in the repo, and their conditional
// rendering is untouched.
//
// A FUNCTION RETURNING AN ARRAY, NOT A COMPONENT RETURNING A FRAGMENT, AND
// THAT IS THE WHOLE POINT OF THE SHAPE. As a component this rendered
// `<>{children}</>`, which made the run ONE React child of the grid carrying
// no panelId of its own. CardGrid reads the live order off the DOM, where each
// wrapped Card is plainly visible, but applies a saved order to its React
// children (sortByOrder), where that same run was a single anonymous node
// ranked last. So a tab with both a layoutKey and one of these runs saved an
// order it could not honour and shoved the run to the end on reload — the
// disagreement lib/layout.js's unseenPanelIds exists to shout about. Returning
// an array means React flattens each Card straight into the grid's children
// again, with its own props.panelId, and the two views agree.
//
// Called inline from the tab, so the run reads as part of the JSX:
//
//   {hiddenPanelGroup({ ...SERVICE_GROUPS.dns, state: owned, children: [
//     <QpsHero key="dns-query-rate" panelId="dns-query-rate" qps={qps} />,
//   ] })}
//
// The collapsed row is still a grid child, but it never registers with the
// grid's fit map, so applyLayout skips it and it keeps the full-width span
// class below. It carries no data-panel-id either, so a collapsed run writes
// nothing into the saved order that could not be restored.
//
// The group's session key is derived from the service list, so two separate
// runs that need the same service (DNS Query Rate and DNS Services sit either
// side of a panel that is NOT hidden) share one "show anyway": revealing one
// reveals both, which is what an operator who asked to see the DNS panels
// meant.
export function hiddenPanelGroup({ services, label, state, children }) {
  const panels = Children.toArray(children)
  const groupKey = [...services].sort().join('+')
  const hidden = shouldHidePanel(state, services) && !state.revealed.has(groupKey) && panels.length > 0
  if (!hidden) return panels
  return [<HiddenPanelsRow key={`hidden-panels-${groupKey}`} groupKey={groupKey} label={label} n={panels.length} />]
}

// The collapsed row, kept as its own component for one reason: it needs a hook,
// and hiddenPanelGroup above is a plain function that cannot legally hold one.
// Everything a test can see — the testid, the sentence, the button's name, its
// aria-expanded, where focus lands — is what it was when this markup lived in
// the wrapper component.
function HiddenPanelsRow({ groupKey, label, n }) {
  // WHERE FOCUS GOES WHEN THE RUN IS REVEALED. The button that had focus is
  // unmounted by its own click — the whole row is replaced by the panels it was
  // standing in for — so without this, focus falls to <body> and a keyboard or
  // screen-reader user is dropped back at the top of the document with no way
  // to tell whether anything appeared.
  //
  // ON UNMOUNT, VIA useEffect, AND THE CHOICE OF EFFECT IS LOAD-BEARING. When
  // this markup lived in the wrapper component, the component survived the
  // reveal (it re-rendered as a fragment) and a useLayoutEffect could do the
  // work. This row does not survive it. A useLayoutEffect cleanup runs during
  // the mutation phase, where React processes deletions BEFORE placements — the
  // revealed panels would not be in the document yet. A passive cleanup runs
  // after the whole commit, so the panels are there to be focused.
  //
  // The slot is remembered as "whatever follows this row's previous sibling",
  // not as a child index: `showAnyway` reveals every group sharing this key at
  // once (DNS Query Rate and DNS Services sit either side of a panel that is
  // NOT hidden), so an earlier group expanding from one row into several
  // panels shifts every index after it. A sibling reference survives that.
  const rowRef = useRef(null)
  const focusSlotRef = useRef(null)
  useEffect(
    () => () => {
      const slot = focusSlotRef.current
      focusSlotRef.current = null
      if (!slot) return
      const el = slot.prev ? slot.prev.nextElementSibling : slot.parent.firstElementChild
      if (!el) return
      // tabindex -1, so it is focusable by script and stays out of the tab order.
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
      el.focus()
    },
    [],
  )

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
      className="col-span-2 md:col-span-4 xl:col-span-6 flex flex-wrap items-center gap-2 rounded-surface border border-dashed border-card-border px-3 py-2 text-note text-muted"
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
        className="rounded-control border border-border px-2 py-0.5 text-note text-muted cursor-pointer hover:text-field-txt"
      >
        show anyway
      </button>
    </div>
  )
}

// One-line "what this tab does" line under a tab title, with a way into the
// matching section of docs/TABS.md. Always-visible text rather than a hover
// tooltip: the nav collapses tabs into a ⋯ menu at narrow widths and hover
// does not exist on touch, so a tooltip is the one place this can't be read.
//
// "Docs" USED TO LEAVE THE APP. It was an <a> to the file on GitHub, which
// meant the answer to "what is this tab" was a new browser tab, a page load,
// and a scroll to an anchor — and it was unreadable on a machine that cannot
// reach github.com, which is a normal condition for the networks this tool is
// pointed at. It is now a button that opens the same words in a panel beside
// the page they describe. The document itself still lives on GitHub and is
// still the single source: the panel renders `docs/TABS.md` imported at build
// time, so there is no second copy to drift.
const DocsPanel = lazy(() => import('./DocsPanel.jsx'))

export function TabIntro({ anchor, children }) {
  const [open, setOpen] = useState(false)
  // Focus goes back to the control that opened the panel, which the panel
  // cannot do itself — it is unmounted by the time the focus has to land. Same
  // division of labour as App.jsx and HeaderHelp.
  const btnRef = useRef(null)
  const close = () => {
    setOpen(false)
    btnRef.current?.focus()
  }
  return (
    <p className="text-note text-muted mb-3 max-w-[80ch]">
      {children}{' '}
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="text-accent underline underline-offset-2 whitespace-nowrap cursor-pointer bg-transparent border-0 p-0 text-note"
      >
        Docs →
      </button>
      {open && (
        // No fallback element: the panel is the only thing on screen that would
        // change, and a skeleton the size of a full-height sheet flashing in
        // and out is more movement than the wait it covers. The chunk is ~14 KB.
        <Suspense fallback={null}>
          <DocsPanel anchor={anchor} onClose={close} />
        </Suspense>
      )}
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

const PA_BTN = 'px-3.5 py-1.5 rounded-control text-copy font-medium disabled:opacity-40 disabled:cursor-not-allowed'

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
          style={{ background: COLORS.accent, color: COLORS.onAccent }}
        >
          {busy ? busyLabel : previewLabel}
        </button>
        {showApply && (
          <button
            type="button"
            onClick={onApply}
            disabled={applyDisabled}
            className={PA_BTN}
            style={{ background: destructive ? COLORS.crit : COLORS.ok, color: destructive ? COLORS.onCrit : COLORS.onOk }}
          >
            {applyLabel}
          </button>
        )}
        {showApply && applyDisabled && applyNote && (
          <span className="text-note" style={{ color: COLORS.warn }}>{applyNote}</span>
        )}
        {status === 'previewed' && stale && (
          <span className="text-note" style={{ color: COLORS.warn }}>
            inputs changed — preview again
          </span>
        )}
      </div>

      {error && (
        <div
          className="text-copy rounded-control px-3 py-2"
          style={{ background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)', border: `1px solid ${COLORS.crit}` }}
        >
          {error}
        </div>
      )}
      {/* A stale preview's message ("review it, then apply") is no longer true —
          the warning above replaces it rather than sitting next to it. */}
      {!error && message && !stale && (
        <div
          className="text-copy rounded-control px-3 py-2"
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
    <div className="rounded-control border border-border bg-field p-3">
      <div className="text-note text-dim mb-1.5">{note}</div>
      <pre className="text-note whitespace-pre-wrap max-h-[320px] overflow-auto text-muted">
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}

// Lives here because SelfService.jsx, Provision.jsx and Drift.jsx all have the
// identical problem — a picker whose useApi failed renders byte-identically to a
// tenant that owns nothing — and the answer must be the identical component in
// one shared place, not three that drift away from this wording.
// A DELETE that upstream answered 404 for is still a success, but it is NOT the
// same success as one this system carried out: the object was already gone, so
// nothing here removed anything, and telling the operator "deleted." claims an
// act that never happened. go/internal/edit/resources.go sets already_gone
// explicitly on BOTH arms precisely so the two are distinguishable.
//
// The field's ABSENCE is UNKNOWN, not false — an older server never sent it —
// so it gets its own honest wording rather than being folded into either
// confident answer. Shared by SelfService.jsx and Editor.jsx for the same
// reason FetchError above is: one wording, one place, no drift.
export function deletedMsg(j, label) {
  if (j?.already_gone === true) return `${label} was already gone — nothing was deleted.`
  if (j?.already_gone === false) return `${label} deleted.`
  return `${label} delete accepted — the server did not report whether it still existed.`
}

export function FetchError({ error, stale }) {
  if (!error) return null
  return (
    <div className="text-note mb-2" style={{ color: COLORS.crit }}>
      Could not load current data: {String(error?.message || error)}
      {stale && ' — the list below may be out of date.'}
    </div>
  )
}

export function Empty({ children = 'no data' }) {
  return <div className="h-full min-h-[100px] flex items-center justify-center text-muted text-copy">{children}</div>
}

// A dead upstream feed must never read as "you have none" — this is visually
// and lexically distinct from <Empty>: no zero-count language, no "no data".
//
// `onRetry` is for the handful of callers that own their own fetch and are not
// in the useApi registry (VaultGate, TenantManager). Everyone else gets the
// page-wide answer, which is the point: threading a callback through 75 render
// sites is the per-call-site mistake this codebase has already had to undo.
export function FeedUnavailable({ reason, label = 'Feed unavailable', onRetry }) {
  const { COLORS } = useChartTheme()
  // failed = something on this page is broken; retrying = something is already
  // loading again. The pair separates "hold on" from "this is as far as it got".
  const { failed, retrying } = useFeedRecovery()
  // A caller that passed onRetry has already decided it is stuck — it has no
  // registry entry to set `failed`, so the global pair cannot answer for it.
  const showButton = onRetry ? true : failed && !retrying
  // data-feed-unavailable carries the label so a test can name WHICH feed is
  // down without scraping the rendered text. tests/contrast.spec.ts uses it to
  // tell "the page never loaded" apart from "the page loaded and its feeds did
  // not answer" — two states that look identical to an element count.
  // Attribute only: no text and no class changes, because the
  // failure-not-absence-*.spec.ts suite asserts this component's exact copy.
  // The recovery line and button below are APPENDED for the same reason: the
  // two divs above, their classes and the attribute stay byte-identical, and
  // neither addition may contain "unavailable" or "no data", which other specs
  // assert absent when a feed is genuinely empty rather than broken.
  return (
    <div
      data-feed-unavailable={label}
      className="h-full min-h-[100px] flex flex-col items-center justify-center gap-1 text-center px-4"
    >
      <div className="text-copy font-semibold" style={{ color: COLORS.crit }}>{label}</div>
      {reason ? <div className="text-note" style={{ color: COLORS.warn }}>{reason}</div> : null}
      {showButton ? (
        <button
          type="button"
          onClick={onRetry || retryFailedFeeds}
          className="mt-1 px-2.5 py-1 rounded-control border border-border bg-field text-field-txt text-note"
        >
          Try again
        </button>
      ) : retrying ? (
        <div className="text-note text-dim">{"Didn't load — trying again…"}</div>
      ) : null}
    </div>
  )
}

export function Skeleton({ h = 140 }) {
  return <div className="animate-pulse bg-line rounded-control w-full" style={{ height: h }} />
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

