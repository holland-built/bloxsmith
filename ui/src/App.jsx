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
import { FOCUS_RING, Skeleton } from './components/ui.jsx'
import { PageBar } from './components/kit.jsx'
import Palette from './components/Palette.jsx'
import UpdateButton from './components/UpdateButton.jsx'
import { updateReady, useUpdate } from './lib/updateState.js'
import ConnStatus from './components/ConnStatus.jsx'
import VaultGate from './components/VaultGate.jsx'
// The Settings sheet is fetched when it is first opened. It is 19 KB that no
// first paint needs, and with it in the entry file #provision went over the
// budget tests/bundle-budget.spec.ts holds it to.
const TenantManager = lazy(() => import('./components/TenantManager.jsx'))
// Puts the saved spacing on <html> before the first paint. This module used to
// arrive through the Settings sheet's own imports; now that the sheet loads
// late, it has to be asked for here or a saved Compact would wait for Settings
// to be opened.
import './lib/density.js'
import HeaderHelp from './components/HeaderHelp.jsx'
import { ThemeToggle } from './components/ThemeSwitch.jsx'
import { BrandLogoImg, BrandEdit } from './components/BrandLogo.jsx'

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
// The Settings sheet loads on demand, so its file can fail to arrive (the app
// updated under an open page and the old file is gone). The page behind is
// inert while the sheet is open, so the message is pinned where it is seen and
// carries its own two ways out: reload, or close and carry on without Settings.
class SettingsBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    const btn = `px-2.5 py-1 rounded-control border border-border text-copy text-txt cursor-pointer hover:border-border-hover ${FOCUS_RING}`
    return (
      <div className="fixed top-4 inset-x-4 z-[200] flex flex-wrap items-center gap-3 border border-border bg-card p-4 text-copy text-txt">
        <span role="alert" className="flex-1">Settings could not load.</span>
        <button type="button" ref={(el) => el?.focus()} onClick={() => location.reload()} className={btn}>Reload the page</button>
        <button type="button" onClick={this.props.onClose} className={btn}>Close</button>
      </div>
    )
  }
}

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

// The dropdown shell. A floating surface — same panel whether it hangs off one
// group button or off the collapsed Menu button, so the two forms cannot drift
// apart.
const MenuPanel = ({ ref, label, onKeyDown, children }) => (
  <div
    ref={ref}
    role="menu"
    aria-label={label}
    onKeyDown={onKeyDown}
    className="absolute left-0 top-full mt-2 min-w-[214px] z-20 bg-card border border-border rounded-surface shadow-lg p-1.5"
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
      <div aria-hidden="true" className="px-2.5 pt-2 pb-1 text-note text-dim">
        {group.question || group.label}
      </div>
      {tabs.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          role="menuitem"
          aria-current={t.id === tab ? 'page' : undefined}
          onClick={onPick}
          className={
            'flex items-center justify-between gap-2 h-8 px-2.5 rounded-control text-copy no-underline ' +
            (t.id === tab ? 'bg-line-2 text-txt' : 'text-field-txt hover:bg-line hover:text-txt')
          }
        >
          <span>{t.label}</span>
          {t.id === tab && <span aria-hidden="true">✓</span>}
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
  const { info: updateInfo, phase: updatePhase } = useUpdate()
  const updateIsReady = updateReady(updateInfo)
  // The bar says "update check failed" from 768px up; below it this is how a
  // phone finds out. A dev build and a switched-off check say nothing, as in
  // UpdateButton.
  const updateCheckFailed =
    !!updateInfo &&
    !!updateInfo.error &&
    !updateInfo.checkDisabled &&
    !String(updateInfo.current || '').startsWith('dev-')
  // Something to look at in Settings. The install's own state comes first: a
  // failed or running install leaves the update still "available", and saying
  // "ready to install" over a failure would be the wrong sentence.
  const settingsNote =
    updatePhase === 'error'
      ? 'The last update failed'
      : updatePhase === 'applying' || updatePhase === 'restarting'
        ? 'An update is installing'
        : updateIsReady
          ? 'An update is ready to install'
          : updateCheckFailed
            ? 'The last update check failed'
            : ''

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
  const currentGroup = groupOf(tab)
  const activeLabel = PAGES.find((t) => t.id === tab)?.label ?? ''
  // WCAG 2.4.2. The tabs are a hash router, so the title is the only thing the
  // browser history and the window list say about where you are.
  useEffect(() => {
    document.title = activeLabel ? `${activeLabel} — Bloxsmith` : 'Bloxsmith'
  }, [activeLabel])

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

  // Closing the settings sheet returns focus to the Settings button that opened it. Done
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
  // There is one door now — the settings sheet's link — so focus goes back to
  // the Settings button the reader started from.
  const helpWasOpen = useRef(false)
  useEffect(() => {
    if (showHeaderHelp) helpWasOpen.current = true
    else if (helpWasOpen.current) {
      helpWasOpen.current = false
      settingsBtnRef.current?.focus()
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
  // still reaches the Settings button — just later, when the dialog itself closes.
  const openHelpFromSettings = () => {
    sheetWasOpen.current = false
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
          <header className="flex items-center gap-2 sm:gap-3 px-3 sm:px-5 py-3 border-b border-line-2 bg-bg/95 backdrop-blur sticky top-0 z-10">
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
            {/* The wordmark folds below `lg`. The logo button above does NOT fold:
                it is 20px, and it is the only way into brand editing. */}
            <strong className="tracking-tight shrink-0 hidden lg:inline">Bloxsmith</strong>
            {/* Five group buttons, plain text. Which form shows is a static CSS
                breakpoint, so both forms are right on the very first paint and
                nothing is measured. Below `xl` they give way to one "Menu"
                button, because the right-hand cluster is shrink-0 and five
                labelled buttons would otherwise paint over it.

                min-w-fit, NOT min-w-0: a flex-1 item with min-width:0 collapses
                its own box to zero when the row is over-full and lets its
                shrink-0 contents paint over the neighbour. fit-content makes the
                nav own its real width, so an over-full header scrolls honestly
                instead of overlapping silently. */}
            <nav aria-label="Sections" className="flex-1 min-w-fit flex items-center gap-2 sm:gap-3">
              <div className="hidden xl:flex items-center gap-1 shrink-0">
                {GROUPS.map((g, i) => {
                  const open = openGroup === g.id
                  const current = currentGroup === g.id
                  return (
                    <div key={g.id} className="relative flex">
                      {/* Two attributes below are the whole of what a screen
                          reader gets that a sighted user gets from paint:
                          `aria-current` says WHICH group holds the tab you are on
                          (the tint alone is colour), and `aria-label` names the
                          button as a section, because the AI tab's send button
                          is also called "Ask" and two controls answering to one
                          name is an ambiguous answer. The digit keys still open
                          these; aria-keyshortcuts and the tooltip say so, and so
                          does the "What these controls do" dialog. */}
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
                          'flex items-center gap-1.5 h-8 px-3 rounded-control text-copy font-medium whitespace-nowrap cursor-pointer ' +
                          (open || current ? 'bg-line-2 text-txt' : 'text-muted hover:bg-line hover:text-txt')
                        }
                      >
                        {g.label}
                        <Caret open={open} />
                      </button>
                      {open && (
                        <MenuPanel ref={menuRef} label={g.label} onKeyDown={onMenuKey}>
                          <GroupSection group={g} tab={tab} onPick={() => setOpenGroup(null)} />
                        </MenuPanel>
                      )}
                    </div>
                  )
                })}
              </div>
              {/* Collapsed form, below xl. One button, every group inside it. */}
              <div className="relative flex xl:hidden shrink-0">
                <button
                  ref={(el) => { btnRefs.current.menu = el }}
                  type="button"
                  data-menu="all"
                  aria-haspopup="menu"
                  aria-expanded={openGroup === 'menu'}
                  onClick={() => setOpenGroup(openGroup === 'menu' ? null : 'menu')}
                  onKeyDown={onTriggerKey('menu')}
                  className={
                    'flex items-center gap-1.5 h-8 px-3 rounded-control text-copy font-medium whitespace-nowrap cursor-pointer ' +
                    (openGroup === 'menu' ? 'bg-line-2 text-txt' : 'text-muted hover:bg-line hover:text-txt')
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
            </nav>
            {/* Five things on the right: an update (only when one is ready), the
                tenant chip with its write state, the light/dark button, Settings,
                and Provision. Light/dark is here because people flip it often
                and expect to see it; the three-way switch with "System", and
                spacing, stay in Settings. The "What these controls do" dialog
                is reached from Settings too.

                Two things give way on a small screen, because a phone cannot hold
                a tenant chip that carries its write state beside all of this:
                below `sm` Provision shrinks to its "+", and below `md` every
                update message becomes a dot on Settings, where the sheet has the
                Install button. The chip is NOT one of the things that gives way. */}
            <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
              <UpdateButton />
              <ConnStatus />
              <ThemeToggle />
              <button
                ref={settingsBtnRef}
                onClick={() => setShowAccounts(true)}
                title={settingsNote ? `Settings — ${settingsNote.toLowerCase()}` : 'Settings'}
                aria-label="Settings"
                aria-description={settingsNote || undefined}
                aria-haspopup="dialog"
                aria-expanded={showAccounts}
                className="relative w-8 h-8 inline-grid place-items-center rounded-control border border-border bg-field text-muted hover:text-txt hover:border-border-hover"
              >
                {settingsNote && (
                  <span aria-hidden="true" className="md:hidden absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-accent border-2 border-bg" />
                )}
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M2 5h7M13 5h1M2 11h1M7 11h7" />
                  <circle cx="11" cy="5" r="1.6" />
                  <circle cx="5" cy="11" r="1.6" />
                </svg>
              </button>
              <a
                href="#provision"
                aria-label="Provision"
                title="Provision"
                className="px-2.5 py-1.5 rounded-control bg-accent border border-accent text-on-accent text-copy font-medium no-underline"
              >
                +<span className="hidden sm:inline"> Provision</span>
              </a>
            </div>
          </header>
          {/* Where you are, Kentik-style: the group and the tab. Pages outside
              the groups (a dossier) have no group and so no bar. */}
          {groupOf(tab) && (
            <PageBar group={GROUPS.find((g) => g.id === groupOf(tab)).label} page={activeLabel}>
              {tab !== 'ai' && (
                <a href="#ai" className={`px-2.5 py-1 rounded-control border border-border text-copy text-txt no-underline hover:border-border-hover ${FOCUS_RING}`}>
                  Ask
                </a>
              )}
            </PageBar>
          )}
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
          <SettingsBoundary onClose={() => setShowAccounts(false)}>
            {/* The page behind is already inert, so the wait is said out loud
                and dimmed like the sheet it is about to become. */}
            <Suspense fallback={<div role="status" className="fixed inset-0 z-[200] grid place-items-center bg-black/60 text-copy text-txt">Loading settings…</div>}>
              <TenantManager onClose={() => setShowAccounts(false)} onOpenHelp={openHelpFromSettings} />
            </Suspense>
          </SettingsBoundary>
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
