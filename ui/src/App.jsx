import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react'
// Every tab is fetched on demand. Before this, all 15 were static imports and
// the app shipped as one ~903 KB file, so opening #provision — a tab with no
// charts on it at all — still downloaded recharts and the other 14 tabs.
//
// Overview is lazy too, deliberately. It is the default tab, so it is tempting
// to import it eagerly "because it is always needed": it is not. The landing
// tab comes from the URL hash, and someone who opens #security or clicks the
// header's "+ Provision" never renders Overview at all — an eager Overview is
// pure dead weight on every one of those loads, and it carries recharts with it.
//
// The TABS entries below keep exactly the shape they had (`{ id, label, el }`),
// so the DEV completeness check and the Palette are untouched by this.
const Overview = lazy(() => import('./tabs/Overview.jsx'))
const Daily = lazy(() => import('./tabs/Daily.jsx'))
const Network = lazy(() => import('./tabs/Network.jsx'))
const Dns = lazy(() => import('./tabs/Dns.jsx'))
const Security = lazy(() => import('./tabs/Security.jsx'))
const Infra = lazy(() => import('./tabs/Infra.jsx'))
const Assets = lazy(() => import('./tabs/Assets.jsx'))
const Incidents = lazy(() => import('./tabs/Incidents.jsx'))
const Audit = lazy(() => import('./tabs/Audit.jsx'))
const Changes = lazy(() => import('./tabs/Changes.jsx'))
const Provision = lazy(() => import('./tabs/Provision.jsx'))
const Editor = lazy(() => import('./tabs/Editor.jsx'))
const Drift = lazy(() => import('./tabs/Drift.jsx'))
const SelfService = lazy(() => import('./tabs/SelfService.jsx'))
const Ai = lazy(() => import('./tabs/Ai.jsx'))
const DossierPage = lazy(() => import('./components/DossierPage.jsx'))
import { Skeleton } from './components/ui.jsx'
import Palette from './components/Palette.jsx'
import UpdateButton from './components/UpdateButton.jsx'
import ConnStatus from './components/ConnStatus.jsx'
import VaultGate from './components/VaultGate.jsx'
import TenantManager from './components/TenantManager.jsx'
import HeaderHelp from './components/HeaderHelp.jsx'
import { BrandLogoImg, BrandEdit } from './components/BrandLogo.jsx'
import ThemeSwitch from './components/ThemeSwitch.jsx'
import DensitySwitch from './components/DensitySwitch.jsx'

const TABS = [
  { id: 'overview', label: 'Overview', el: Overview },
  { id: 'daily', label: 'Daily', el: Daily },
  { id: 'network', label: 'Network', el: Network },
  { id: 'dns', label: 'DNS', el: Dns },
  { id: 'security', label: 'Security', el: Security },
  { id: 'infra', label: 'Infra', el: Infra },
  // Assets sits after Infra, not at the end: Infra's "Asset Discovery" tile is
  // where an operator first sees an asset count, and this is the tab that
  // answers the next question. A read-only tab appended after the write-capable
  // ones would also break the read-then-write ordering the nav already has.
  { id: 'assets', label: 'Assets', el: Assets },
  { id: 'incidents', label: 'Incidents', el: Incidents },
  { id: 'audit', label: 'Audit', el: Audit },
  // Changes reads the same CSPAudit feed Audit does, windowed to the last 24
  // hours and grouped by what was touched — so it sits next to its source, not
  // with the write-capable tabs whose name it shares.
  { id: 'changes', label: 'Changes', el: Changes },
  { id: 'provision', label: 'Provision', el: Provision },
  { id: 'selfservice', label: 'Self-Service', el: SelfService },
  { id: 'editor', label: 'Editor', el: Editor },
  { id: 'drift', label: 'Drift', el: Drift },
  { id: 'ai', label: 'AI', el: Ai },
]

// Pages that are routable but are NOT in the nav and NOT in the palette's
// tab-jump list. `#dossier?q=…` is reached from the palette's indicator row and
// from the AI tab's lookup card; it is a view of one thing you searched for, so
// there is nothing for a nav entry to point at until you have searched.
//
// The split matters, and it is the reason this is a second array rather than a
// 16th TABS entry: `TABS` is what the nav groups and the Palette consume, and
// both would be wrong to list this. `PAGES` is what routing consumes.
// The label is here only so the header's "Tab —" readout has something to say
// on a hidden page; nothing iterates HIDDEN_PAGES to build a menu.
const HIDDEN_PAGES = [{ id: 'dossier', label: 'Search result', el: DossierPage }]
const PAGES = [...TABS, ...HIDDEN_PAGES]

function hashTab() {
  // '#editor?type=subnet' deep-links: tab id is the part before '?'
  const h = location.hash.replace('#', '').split('?')[0]
  return PAGES.some((t) => t.id === h) ? h : 'overview'
}

// ---------- group nav ----------
//
// 14 tabs used to render as one flat strip fitted by ~165 lines of
// measure-then-render machinery (hidden probes, a ResizeObserver, a
// callback-ref mount detector) whose entire job was squeezing 14 items into
// one row. Five group buttons need no arithmetic to place: they render
// unconditionally on the first paint, and how many of them are shown is a
// static CSS breakpoint (see the nav markup), so there is no measure-then-
// correct second paint left to race against.
//
// This is a presentation layer OVER `TABS`. Tab ids, their order in `TABS`,
// `hashTab()` and the Palette are all untouched — every `#id` URL keeps
// behaving exactly as before, it is only the way a tab is *reached by mouse*
// that changed.
const GROUPS = [
  { id: 'status', label: 'Status', question: 'How are we doing?', tabIds: ['overview', 'daily'] },
  { id: 'estate', label: 'Estate', question: 'What do we have?', tabIds: ['network', 'dns', 'assets', 'infra'] },
  { id: 'risk', label: 'Risk', question: 'Are we safe?', tabIds: ['security', 'incidents', 'audit', 'changes'] },
  { id: 'change', label: 'Change', question: 'Change something', tabIds: ['provision', 'selfservice', 'editor', 'drift'] },
  { id: 'ask', label: 'Ask', question: '', tabIds: ['ai'] },
]

// Dev-only completeness check. A tab missing from every group is unreachable
// by mouse (its hash still works, so nothing throws and nothing looks broken —
// which is exactly why this needs to shout at the developer who adds tab 15).
if (import.meta.env?.DEV) {
  const seen = GROUPS.flatMap((g) => g.tabIds)
  const dupes = seen.filter((id, i) => seen.indexOf(id) !== i)
  const missing = TABS.map((t) => t.id).filter((id) => !seen.includes(id))
  const unknown = seen.filter((id) => !TABS.some((t) => t.id === id))
  if (missing.length || unknown.length || dupes.length) {
    throw new Error(
      `GROUPS must cover every TABS id exactly once — ` +
        `missing: [${missing}], unknown: [${unknown}], duplicated: [${dupes}]`,
    )
  }
}

const groupOf = (tabId) => GROUPS.find((g) => g.tabIds.includes(tabId))?.id ?? null

// What fills <main> on a COLD first load, while the landing tab's chunk is
// still downloading. It is not reachable on a tab switch: React keeps the
// outgoing tab on screen until the next chunk resolves (measured — see the
// hash-change handler), so this is the app's first paint and nothing else.
//
// It is the grid's own shape rather than a spinner, and it reserves height, so
// the header does not sit alone on a tall empty page and the content does not
// jump downward when the real tab lands underneath it. Skeleton is the existing
// component from components/ui.jsx, which is what the tabs themselves use while
// their data loads — one loading vocabulary, not two.
const TabLoading = () => (
  <div className="p-5 min-h-[70vh]" aria-hidden="true">
    <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
      <Skeleton h={150} />
      <Skeleton h={150} />
      <Skeleton h={150} />
      <Skeleton h={220} />
      <Skeleton h={220} />
      <Skeleton h={220} />
    </div>
  </div>
)

// A chunk fetch can fail — a flaky connection, or a stale tab open across a
// deploy that replaced the hashed filenames. React's answer to a rejected lazy
// import is to unmount the whole tree, so WITHOUT this the reader gets a white
// page and a console error nobody sees. Reset on tab change: a different tab is
// a different chunk, and the one that failed should not poison the ones that
// would load fine.
//
// The wording is aimed at whoever is actually looking at it, who is an operator
// and not an engineer: it says what happened and the one thing that fixes it.
// No error code, no stack, no "unexpected error occurred".
class TabErrorBoundary extends Component {
  state = { failed: false, tab: null }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  // Reset by deriving from props rather than by setState in componentDidUpdate:
  // the latter renders the failed state once and then immediately renders
  // again, so the reader gets a frame of the error message on a tab that is
  // loading perfectly well. Deriving clears it in the same render.
  //
  // Ordering note, since the two statics look like they could fight: after a
  // throw, getDerivedStateFromError sets failed, then this runs with the tab
  // unchanged and returns null, so the error survives its own re-render.
  static getDerivedStateFromProps(props, state) {
    return props.tab === state.tab ? null : { failed: false, tab: props.tab }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="p-5">
        <div role="alert" className="border border-border bg-card p-4 text-copy text-txt">
          This tab could not load. Reload the page.
        </div>
      </div>
    )
  }
}

const Caret = ({ open }) => (
  <span aria-hidden="true" className={'text-[9px] ' + (open ? 'text-field-txt' : 'text-dim')}>
    {open ? '▴' : '▾'}
  </span>
)

// The dropdown shell. Square, hairline, accent-topped — same panel whether it
// hangs off one group cell or off the collapsed Menu cell, so the two forms
// cannot drift apart.
const MenuPanel = ({ ref, label, onKeyDown, children }) => (
  <div
    ref={ref}
    role="menu"
    aria-label={label}
    onKeyDown={onKeyDown}
    style={{ borderTopColor: 'var(--color-accent)' }}
    className="absolute left-[-1px] top-full mt-2 min-w-[214px] z-20 bg-card border border-border shadow-lg"
  >
    {children}
  </div>
)

// One group's worth of menu: its heading, then a row per tab. The row for the
// tab you are already on says so — a menu that reveals nothing about where you
// are is the orientation cost of dropping the flat strip.
//
// role="group" is not decoration. A `menu` may own menuitems, groups and
// separators — nothing else — and the collapsed form below `xl` puts all five
// sections in ONE menu. Without the group wrapper its 15 items arrive as one
// undifferentiated list (the heading rows are styled divs, invisible to the
// accessibility tree), so the Status/Estate/Risk split a sighted user can see
// simply does not exist for a screen reader. The heading row is aria-hidden
// because the group's own name now carries it.
const GroupSection = ({ group, tab, onPick }) => {
  const tabs = group.tabIds.map((id) => TABS.find((t) => t.id === id))
  return (
    <div role="group" aria-label={group.label}>
      <div
        aria-hidden="true"
        className="flex items-center justify-between h-[22px] px-2 bg-field border-y border-card-border"
      >
        <span className="text-note uppercase tracking-[0.12em] text-dim">
          {group.question || group.label}
        </span>
        <span className="font-mono text-note text-dim">
          {tabs.length} tab{tabs.length === 1 ? '' : 's'}
        </span>
      </div>
      {tabs.map((t, j) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          role="menuitem"
          aria-current={t.id === tab ? 'page' : undefined}
          onClick={onPick}
          style={t.id === tab ? { boxShadow: 'inset 2px 0 0 var(--color-accent)' } : undefined}
          className={
            'grid grid-cols-[1fr_auto] items-center gap-2 h-[27px] px-2 text-copy no-underline ' +
            (j < tabs.length - 1 ? 'border-b border-line ' : '') +
            (t.id === tab ? 'bg-line text-txt' : 'text-field-txt hover:bg-line-2 hover:text-txt')
          }
        >
          <span>{t.label}</span>
          {t.id === tab && (
            <span className="text-note uppercase tracking-[0.08em] px-1.5 py-0 bg-[var(--pill-ok-bg)] text-[var(--pill-ok-fg)]">
              Here
            </span>
          )}
        </a>
      ))}
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState(hashTab)
  const [showAccounts, setShowAccounts] = useState(false)
  const [showHeaderHelp, setShowHeaderHelp] = useState(false)
  const [showBrand, setShowBrand] = useState(false)
  const [brandDomain, setBrandDomain] = useState(() => localStorage.getItem('orgDomain') || '')
  const [logoBust, setLogoBust] = useState(0)

  useEffect(() => {
    fetch('/api/brand', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (b && b.domain) setBrandDomain(b.domain) })
      .catch(() => {})
  }, [])

  // A PLAIN setState, AND THAT IS A DELIBERATE REVERSAL — this was written with
  // startTransition around it first, on the theory that a lazy tab switch would
  // otherwise flash the Suspense fallback. Both halves of that theory were
  // measured on 2026-08-10 and both came out against it:
  //
  //   - It prevents no flash, because there is none to prevent. Built without
  //     the wrapper and with the chunk fetch held for 2.5s, the outgoing tab
  //     stayed fully on screen for all 304 sampled frames and the fallback
  //     never painted. React 19 already keeps committed content visible when an
  //     update suspends; it does not need to be told.
  //   - It costs something real. Deferring this setState defers EVERYTHING it
  //     feeds, including which nav group carries aria-current — so the header
  //     went on pointing at the tab you just left until the chunk landed.
  //     tests/nav-groups.spec.ts caught it: on #ai the marked group was still
  //     `risk`. That marker is the only non-colour signal of where you are, so
  //     lagging it is a straight accessibility regression.
  //
  // Paying an a11y regression for a flash that does not happen is a bad trade,
  // so the transition is gone. The chunk it waits for is 6–20 kB, and the
  // outgoing tab stays put meanwhile, so there is nothing left to smooth over.
  //
  // What WOULD flash, if anyone is tempted: keying the Suspense boundary below
  // by tab. That destroys the old tab immediately and the heading vanishes for
  // 37 of 97 frames — tests/tab-switch-no-flash.spec.ts is what caught that.
  useEffect(() => {
    const on = () => setTab(hashTab())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const Active = PAGES.find((t) => t.id === tab)?.el ?? Overview

  // Exactly one group menu is open at a time: `openGroup` holds its id, or
  // null. (The flat nav's boolean `menuOpen` could not express that, because
  // it only ever had one menu to describe.)
  const [openGroup, setOpenGroup] = useState(null)
  const btnRefs = useRef({})
  const menuRef = useRef(null)
  const mainRef = useRef(null)
  const settingsBtnRef = useRef(null)
  const helpBtnRef = useRef(null)
  // The element the control-help dialog hands focus back to. Not always the ⓘ:
  // the dialog has two doors now, and focus belongs on the one that was used.
  const helpReturnRef = useRef(null)
  const currentGroup = groupOf(tab)
  const activeLabel = PAGES.find((t) => t.id === tab)?.label ?? ''

  // Any tab change dismisses the open menu — including a hash change that
  // came from somewhere else entirely (a card drill-down, the palette).
  useEffect(() => {
    setOpenGroup(null)
  }, [tab])

  // Outside-click + Escape: same behaviour as the More menu this replaces,
  // with the boolean swapped for "which group".
  useEffect(() => {
    if (!openGroup) return undefined
    const onDocClick = (e) => {
      if (menuRef.current?.contains(e.target)) return
      if (btnRefs.current[openGroup]?.contains(e.target)) return
      setOpenGroup(null)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        btnRefs.current[openGroup]?.focus()
        setOpenGroup(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [openGroup])

  // A `role="menu"` promises menu keyboard behaviour to anyone driving this
  // from the keyboard or from a screen reader's menu mode. It shipped with the
  // role and none of the behaviour: focus stayed on the trigger, so ArrowDown
  // scrolled the document instead of moving between items. These two pieces —
  // focus enters the menu on open, arrows move inside it — are what makes the
  // role true. Escape and outside-click are handled above; this deliberately
  // does not grow a second copy of them.
  const menuItems = () => [...(menuRef.current?.querySelectorAll('a[role="menuitem"]') ?? [])]

  useEffect(() => {
    if (!openGroup) return
    // The panel renders in this same commit, so by here it exists.
    menuRef.current?.querySelector('a[role="menuitem"]')?.focus()
  }, [openGroup])

  const onMenuKey = (e) => {
    const items = menuItems()
    if (!items.length) return
    const at = items.indexOf(document.activeElement)
    const go = (i) => {
      e.preventDefault() // Arrow keys must move focus, never scroll the page.
      items[(i + items.length) % items.length].focus()
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
  }

  // ArrowDown/ArrowUp on a closed trigger opens its menu, which is both the
  // standard binding and the reason those two keys cannot scroll the page from
  // the nav bar either.
  const onTriggerKey = (id) => (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    setOpenGroup(id)
  }

  // Focus after a tab change. Activating a menu item unmounts the item it was
  // on, which drops focus to BODY: the keyboard user restarts at the top of the
  // document on every single navigation. Moving focus to the tab's own region
  // both puts them at the start of the new content and gets the region's name
  // read out. Skipped on first paint — nothing navigated, so nothing should be
  // stolen from whatever the page loaded with.
  const navigated = useRef(false)
  useEffect(() => {
    if (!navigated.current) {
      navigated.current = true
      return
    }
    mainRef.current?.focus()
  }, [tab])

  // Closing the settings sheet returns focus to the "…" that opened it. Done
  // here rather than inside the sheet because the sheet is unmounted by the
  // time the focus has to land, and because every route out of it (✕, Escape,
  // backdrop click, "Lock vault now") runs through this one state change.
  const sheetWasOpen = useRef(false)
  useEffect(() => {
    if (showAccounts) sheetWasOpen.current = true
    else if (sheetWasOpen.current) {
      sheetWasOpen.current = false
      settingsBtnRef.current?.focus()
    }
  }, [showAccounts])

  // Same contract for the control-help dialog, and deliberately a second copy
  // of five lines rather than a shared hook: the two sheets have different
  // triggers and are unmounted at different times, and a hook parameterised
  // over "which ref, which flag" would be longer than what it replaced.
  //
  // The one difference is WHERE focus lands: `helpReturnRef` is set by whichever
  // door opened the dialog. Always returning to the ⓘ would be wrong twice over
  // when the sheet's link was used — the reader's attention was on "…", and
  // below `lg` the ⓘ is display:none, so focus() on it does nothing at all and
  // the keyboard user is dropped on BODY.
  const helpWasOpen = useRef(false)
  useEffect(() => {
    if (showHeaderHelp) helpWasOpen.current = true
    else if (helpWasOpen.current) {
      helpWasOpen.current = false
      helpReturnRef.current?.focus()
    }
  }, [showHeaderHelp])

  // The settings sheet's "What these controls do →" row. Close, then open —
  // not two stacked modals, which would mean two focus traps and two Escape
  // handlers over each other, and a background that is inert for one reason
  // while a dialog inside it is inert for another.
  //
  // `sheetWasOpen` is cleared by hand because both state changes land in one
  // commit: the sheet's focus-return effect would otherwise fire in the same
  // pass that mounts the dialog and yank focus straight back out of it. Focus
  // still reaches the "…" — just later, when the dialog itself closes.
  const openHelpFromSettings = () => {
    sheetWasOpen.current = false
    helpReturnRef.current = settingsBtnRef.current
    setShowAccounts(false)
    setShowHeaderHelp(true)
  }

  // Digits 1-5 open their group. Each button draws its digit as a keycap, and
  // a keycap that isn't bound to anything is a lie — so the binding is real.
  // It stands down for editable targets (these tabs are full of text inputs)
  // and for any modified keypress, so it can never eat a real keystroke.
  //
  // It also stands down while the settings sheet is open: that sheet is a modal
  // dialog now, and a digit reaching past it would open a menu behind the
  // dialog — focus in one place, the thing that just opened in another.
  //
  // The control-help dialog is the same kind of modal and gets the same
  // standdown for the same reason — it is not a second special case.
  useEffect(() => {
    if (showAccounts || showHeaderHelp) return undefined
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return
      const i = Number(e.key) - 1
      if (!Number.isInteger(i) || i < 0 || i >= GROUPS.length) return
      const id = GROUPS[i].id
      // Below `xl` the five cells are display:none and their keycaps are not
      // on screen, so the digit must not silently swallow the keypress there.
      // offsetParent is null exactly when the button is not being displayed —
      // a visibility question, not a width measurement.
      if (!btnRefs.current[id]?.offsetParent) return
      e.preventDefault()
      setOpenGroup((cur) => (cur === id ? null : id))
      btnRefs.current[id].focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showAccounts, showHeaderHelp])

  return (
    <VaultGate>
      <div className="min-h-screen bg-bg text-txt">
        {/* Everything behind the settings sheet goes inert while it is open, so
            Tab, a screen reader's virtual cursor and the pointer all stay
            inside the dialog. `display: contents` keeps this wrapper out of
            layout entirely — the header's sticky positioning and the flex rows
            below it see exactly the box tree they saw before. */}
        <div style={{ display: 'contents' }} inert={showAccounts || showHeaderHelp}>
          <header className="flex items-center gap-3 px-5 py-3 border-b border-line-2 bg-bg/95 backdrop-blur sticky top-0 z-10">
            <button
              type="button"
              aria-label="Edit brand"
              title="Edit brand"
              onClick={() => setShowBrand(true)}
              className="shrink-0 cursor-pointer"
            >
              <BrandLogoImg
                domain={brandDomain}
                bust={logoBust}
                className="h-5 w-5 rounded-mark"
              />
            </button>
            {/* Wordmark folds below `lg` with the rest of the A3 fold (see the
                controls cluster below). The logo button above does NOT fold: it
                is 20px, and it is the only way into brand editing. */}
            <strong className="tracking-tight shrink-0 hidden lg:inline">Bloxsmith</strong>
            {/* Group bar. Five cells in one hairline strip, square, flush —
                per .mockups/build-bloxsmith-ux/bloxsmith-ux-v11.html (surface A).
                No measurement anywhere: which form shows is a static CSS
                breakpoint, so both forms are correct on the very first paint.

                Below `xl` the five cells give way to one "Menu" cell. That is
                not a taste call: the right-hand controls cluster is a measured
                410px of shrink-0 content, so at narrow widths five labelled
                cells have nowhere to go and paint straight over it — the exact
                overlap the deleted measurer existed to prevent. The breakpoint is
                xl because the five cells measure 552px and the rest of the header
                measures 571px, so they need 1123px before they fit at all. */}
            {/* min-w-fit, NOT min-w-0: a flex-1 item with min-width:0 collapses
                its own box to zero when the row is over-full and lets its
                shrink-0 contents paint straight over the neighbour — which is
                how the old strip came to sit on top of the controls, and it also
                makes the header under-report its own scrollWidth. fit-content
                makes the nav own its real width, so an over-full header scrolls
                honestly instead of overlapping silently. */}
            <nav aria-label="Sections" className="flex-1 min-w-fit flex items-center gap-3">
              <div className="hidden xl:flex items-stretch h-7 border border-border shrink-0">
                {GROUPS.map((g, i) => {
                  const open = openGroup === g.id
                  const current = currentGroup === g.id
                  return (
                    <div key={g.id} className="relative flex">
                      {/* Two attributes below are the whole of what a screen
                          reader gets that a sighted user gets from paint:
                          `aria-current` says WHICH group holds the tab you are on
                          (it was colour and an aria-hidden accent bar only, and
                          the "Tab —" readout that spells it out renders at 2xl
                          and no narrower); `aria-label` names the cell as a
                          section, because the AI tab's send button is also called
                          "Ask" and two controls answering to one name is an
                          ambiguous answer. The visible word stays the first word
                          of the spoken name. */}
                      <button
                        ref={(el) => { btnRefs.current[g.id] = el }}
                        type="button"
                        data-group={g.id}
                        data-current={current}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        aria-current={current ? 'true' : undefined}
                        aria-label={`${g.label} section`}
                        aria-keyshortcuts={String(i + 1)}
                        title={g.question ? `${g.label} — ${g.question} (press ${i + 1})` : `${g.label} (press ${i + 1})`}
                        onClick={() => setOpenGroup(open ? null : g.id)}
                        onKeyDown={onTriggerKey(g.id)}
                        className={
                          'flex items-center gap-2 px-3 font-mono text-note font-semibold uppercase tracking-[0.13em] whitespace-nowrap cursor-pointer ' +
                          (i < GROUPS.length - 1 ? 'border-r border-card-border ' : '') +
                          (open
                            ? 'bg-field text-txt'
                            : current
                              ? 'bg-line text-txt'
                              : 'text-muted hover:bg-line hover:text-field-txt')
                        }
                      >
                        {/* Keycap, not a list index: digits 1-5 are really bound. */}
                        <span
                          aria-hidden="true"
                          className={
                            'inline-block text-note leading-none font-bold text-center min-w-[15px] px-1 pt-0 pb-0 border bg-field ' +
                            (open ? 'border-accent text-txt' : 'border-border text-field-txt')
                          }
                        >
                          {i + 1}
                        </span>
                        {g.label}
                        <Caret open={open} />
                      </button>
                      {/* The active group is marked at the base of its own cell —
                          without it the current tab has no on-screen home. */}
                      {current && (
                        <span aria-hidden="true" className="absolute left-0 right-0 bottom-0 h-0.5 bg-accent" />
                      )}
                      {open && (
                        <MenuPanel ref={menuRef} label={g.label} onKeyDown={onMenuKey}>
                          <GroupSection group={g} tab={tab} onPick={() => setOpenGroup(null)} />
                        </MenuPanel>
                      )}
                    </div>
                  )
                })}
              </div>
              {/* Collapsed form, below lg. One cell, every group inside it. */}
              <div className="relative flex xl:hidden items-stretch h-7 border border-border shrink-0">
                <button
                  ref={(el) => { btnRefs.current.menu = el }}
                  type="button"
                  data-menu="all"
                  aria-haspopup="menu"
                  aria-expanded={openGroup === 'menu'}
                  onClick={() => setOpenGroup(openGroup === 'menu' ? null : 'menu')}
                  onKeyDown={onTriggerKey('menu')}
                  className={
                    'flex items-center gap-2 px-3 font-mono text-note font-semibold uppercase tracking-[0.13em] whitespace-nowrap cursor-pointer ' +
                    (openGroup === 'menu' ? 'bg-field text-txt' : 'bg-line text-txt')
                  }
                >
                  Menu
                  <Caret open={openGroup === 'menu'} />
                </button>
                {openGroup === 'menu' && (
                  <MenuPanel ref={menuRef} label="Sections" onKeyDown={onMenuKey}>
                    {GROUPS.map((g) => (
                      <GroupSection key={g.id} group={g} tab={tab} onPick={() => setOpenGroup(null)} />
                    ))}
                  </MenuPanel>
                )}
              </div>
              {/* Which tab you are on, spelled out — the group label alone names
                  a neighbourhood, not an address. */}
              <div className="hidden 2xl:flex items-center gap-2 min-w-0">
                <span className="text-note uppercase tracking-[0.12em] text-dim shrink-0">Tab</span>
                <span className="font-mono text-note font-semibold uppercase tracking-[0.1em] text-field-txt truncate">
                  {activeLabel}
                </span>
              </div>
            </nav>
            {/* The A3 fold, per .mockups/build-bloxsmith-ux/bloxsmith-ux-v11.html
                (surface A3 and its caption). Unfolded, this cluster measures 410px
                and the whole header needs 647px of content — wider than a 390px
                phone on its own, which is why no nav change could ever fix the
                390px overflow. Below `lg` the wordmark, tenant name, version and
                theme switch fold into the "…" sheet, leaving the connection dot,
                the Menu cell, "…" and "+ Provision" — the mockup's list exactly.

                `lg` and not `xl`: the fold has to lift at a width that already
                fits 647px, and 1024 clears that by 377px, so a tenant with a
                longer name than this one's still fits. Folding at `xl` instead
                would take the theme switch off every 1024–1279px laptop window
                for no measured gain. Static breakpoint, no measurement — the
                JS width measurer this replaced is not coming back. */}
            <div className="flex items-center gap-3 shrink-0">
              <ConnStatus />
              <UpdateButton />
              <ThemeSwitch className="hidden lg:flex" />
              {/* Folds at the same `lg` as the theme switch, and into the same
                  "…" sheet — the two are one pair of appearance controls and
                  splitting them across the fold would leave half the pair on a
                  1024px laptop and half of it two clicks away. */}
              <DensitySwitch className="hidden lg:flex" />
              {/* Folds at the same `lg` as the two switches, and that is the
                  whole argument for the breakpoint: above it, the theme and
                  density switches are in this row and a reader can hold the
                  dialog's list against the row it names. Below it those two are
                  not in the header at all, so a trigger sitting here would
                  point at controls that are not on screen.
                  The DIALOG does not fold — only this button does. Below `lg`
                  it is opened from the settings sheet's "What these controls
                  do →" row, which is where both switches have moved to, so the
                  list is read next to the row it names at every width.
                  THAT ROW IS `lg:hidden`, the exact inverse of this button's
                  `hidden lg:flex` — one door at any width, never two. Reported
                  as "that what do these do is redundant" when both showed at
                  once. If this class is edited, edit that one too
                  (components/TenantManager.jsx). */}
              <button
                ref={helpBtnRef}
                type="button"
                onClick={() => { helpReturnRef.current = helpBtnRef.current; setShowHeaderHelp(true) }}
                aria-label="What these controls do"
                aria-haspopup="dialog"
                aria-expanded={showHeaderHelp}
                className="hidden lg:flex w-8 h-8 items-center justify-center rounded-control border border-border bg-field text-muted hover:text-txt hover:border-border-hover cursor-pointer"
              >
                ⓘ
              </button>
              <button
                ref={settingsBtnRef}
                onClick={() => setShowAccounts(true)}
                title="Settings"
                aria-label="Settings"
                aria-haspopup="dialog"
                aria-expanded={showAccounts}
                className="w-8 h-8 rounded-control border border-border bg-field text-muted hover:text-txt hover:border-border-hover"
              >
                ⋯
              </button>
              <a
                href="#provision"
                className="px-2.5 py-1.5 rounded-control bg-accent border border-accent text-on-accent text-copy font-medium no-underline"
              >
                + Provision
              </a>
            </div>
          </header>
          {/* The landing place for focus after a tab change, and the only named
              region on the page — its name is the tab, so a screen reader that
              lands here is told which tab it landed on. tabIndex -1 makes it a
              focus target without putting it in the Tab order. */}
          <main ref={mainRef} tabIndex={-1} aria-label={`${activeLabel} tab`} className="outline-none">
            <TabErrorBoundary tab={tab}>
              <Suspense fallback={<TabLoading />}>
                <Active />
              </Suspense>
            </TabErrorBoundary>
          </main>
          <Palette tabs={TABS} onPick={(id) => { location.hash = id }} />
        </div>
        {/* Said out loud on every tab change. Focus moving into <main> covers
            most screen readers on its own; this covers the ones that do not
            announce a programmatically focused region, and costs one line.
            Outside the inert wrapper on purpose — inert content is not exposed
            at all, so a live region inside it would go quiet. */}
        <div data-tab-live="" aria-live="polite" aria-atomic="true" className="sr-only">
          {`${activeLabel} tab`}
        </div>
        {showAccounts && (
          <TenantManager onClose={() => setShowAccounts(false)} onOpenHelp={openHelpFromSettings} />
        )}
        {/* Outside the inert wrapper, like the settings sheet above it and for
            the same reason: inert content is not exposed at all, so a dialog
            rendered inside it would be unreachable by the pointer, the Tab key
            and a screen reader alike. */}
        {showHeaderHelp && <HeaderHelp onClose={() => setShowHeaderHelp(false)} />}
        {showBrand && (
          <BrandEdit
            onClose={() => setShowBrand(false)}
            onSaved={() => {
              setBrandDomain(localStorage.getItem('orgDomain') || '')
              setLogoBust(Date.now())
            }}
          />
        )}
      </div>
    </VaultGate>
  )
}
