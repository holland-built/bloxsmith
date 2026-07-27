import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Overview from './tabs/Overview.jsx'
import Daily from './tabs/Daily.jsx'
import Network from './tabs/Network.jsx'
import Dns from './tabs/Dns.jsx'
import Security from './tabs/Security.jsx'
import Infra from './tabs/Infra.jsx'
import Incidents from './tabs/Incidents.jsx'
import Audit from './tabs/Audit.jsx'
import Provision from './tabs/Provision.jsx'
import Editor from './tabs/Editor.jsx'
import Drift from './tabs/Drift.jsx'
import SelfService from './tabs/SelfService.jsx'
import Ai from './tabs/Ai.jsx'
import Palette from './components/Palette.jsx'
import UpdateButton from './components/UpdateButton.jsx'
import ConnStatus from './components/ConnStatus.jsx'
import VaultGate from './components/VaultGate.jsx'
import TenantManager from './components/TenantManager.jsx'
import { BrandLogoImg, BrandEdit } from './components/BrandLogo.jsx'
import { useTheme } from './lib/theme.jsx'

// Vercel-style segmented theme switcher: sun / moon / monitor in one pill.
// Distinct shape from the square kebab button so the two never read as twins.
const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)
const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
)
const MonitorIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
  </svg>
)

function ThemeSwitch() {
  const { mode, setMode } = useTheme()
  const opts = [
    { id: 'light', Icon: SunIcon, label: 'Light' },
    { id: 'system', Icon: MonitorIcon, label: 'System' },
    { id: 'dark', Icon: MoonIcon, label: 'Dark' },
  ]
  return (
    <div className="flex items-center rounded-full border border-border bg-field p-0.5">
      {opts.map(({ id, Icon, label }) => (
        <button
          key={id}
          onClick={() => setMode(id)}
          title={label}
          aria-label={`${label} theme`}
          className={`w-6 h-6 rounded-full flex items-center justify-center ${
            mode === id ? 'bg-line text-txt' : 'text-dim hover:text-muted'
          }`}
        >
          <Icon />
        </button>
      ))}
    </div>
  )
}

const TABS = [
  { id: 'overview', label: 'Overview', el: Overview },
  { id: 'daily', label: 'Daily', el: Daily },
  { id: 'network', label: 'Network', el: Network },
  { id: 'dns', label: 'DNS', el: Dns },
  { id: 'security', label: 'Security', el: Security },
  { id: 'infra', label: 'Infra', el: Infra },
  { id: 'incidents', label: 'Incidents', el: Incidents },
  { id: 'audit', label: 'Audit', el: Audit },
  { id: 'provision', label: 'Provision', el: Provision },
  { id: 'selfservice', label: 'Self-Service', el: SelfService },
  { id: 'editor', label: 'Editor', el: Editor },
  { id: 'drift', label: 'Drift', el: Drift },
  { id: 'ai', label: 'AI', el: Ai },
]

function hashTab() {
  // '#editor?type=subnet' deep-links: tab id is the part before '?'
  const h = location.hash.replace('#', '').split('?')[0]
  return TABS.some((t) => t.id === h) ? h : 'overview'
}

// ---------- overflow nav ----------
//
// The nav used to be a bare overflow-x-auto/no-scrollbar strip: at a narrow
// width it silently scrolled the remaining tabs off-screen with no visible
// hint they existed. Fix follows the same measure-then-render technique
// DataTable.jsx uses for column widths: measure real rendered widths (hidden
// probes, not guesses), compute how many fit, and re-measure on resize via a
// rAF-debounced ResizeObserver guarded by an equality check so an unchanged
// result never re-triggers a render (that guard is what prevents a
// measure -> render -> resize -> measure loop, exactly as in DataTable).
//
// The nav element itself is `flex-1 min-w-0` (it replaces the old bare
// spacer) so its rendered width comes purely from the header row's layout
// (container minus the other shrink-0 items) and never from its own tab
// count — if the nav's size depended on how many tabs we chose to render,
// shrinking to fewer tabs would shrink the nav itself, invalidating the very
// measurement that produced the choice.
const NAV_GAP = 2 // gap-0.5 == 0.125rem == 2px at the default 16px root

function idsEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
function navEqual(a, b) {
  if (!a || !b) return a === b
  return idsEqual(a.visible, b.visible) && idsEqual(a.hidden, b.hidden)
}

const ALL_VISIBLE = { visible: TABS.map((t) => t.id), hidden: [] }

export default function App() {
  const [tab, setTab] = useState(hashTab)
  const [showAccounts, setShowAccounts] = useState(false)
  const [showBrand, setShowBrand] = useState(false)
  const [brandDomain, setBrandDomain] = useState(() => localStorage.getItem('orgDomain') || '')
  const [logoBust, setLogoBust] = useState(0)

  useEffect(() => {
    fetch('/api/brand', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (b && b.domain) setBrandDomain(b.domain) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const on = () => setTab(hashTab())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const Active = TABS.find((t) => t.id === tab)?.el ?? Overview

  // Overflow nav: measure hidden probes (all 13 tab labels + a worst-case
  // "More" label) against the nav's real rendered width, decide how many
  // tabs fit inline, and promote the active tab into the visible set if it
  // would otherwise land in the overflow menu.
  const activeIdRef = useRef(tab)
  activeIdRef.current = tab
  const navWrapRef = useRef(null) // flex-1 min-w-0 sibling-holder: nav + More button both live inside it
  const measureRefs = useRef([])
  const moreProbeRef = useRef(null)
  const prevNavRef = useRef(null)
  const computeRef = useRef(null)
  const widthRef = useRef(0)
  // Starts at null (not ALL_VISIBLE): the nav's first real commit (gated
  // behind VaultGate's async unlock check) and its first correcting setState
  // from the callback ref below can land as TWO separate paints — headless
  // Chrome screenshots (and, in principle, a slow-loading real tab) can
  // catch the browser painting the FIRST one. Defaulting to ALL_VISIBLE made
  // that first paint a fully-overlapping wrong layout; null instead renders
  // no tabs at all until a real measurement exists, so the worst a race can
  // show is a briefly empty nav, never overlap.
  const [navTabs, setNavTabs] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const moreBtnRef = useRef(null)
  const menuRef = useRef(null)

  // navWidth is passed in explicitly (never re-read from the DOM here) so both
  // callers control exactly which measurement it's based on: a post-paint
  // rAF read on mount/tab-change, or the ResizeObserver entry's contentRect
  // on resize — never a plain clientWidth read, which can run before the
  // header's siblings have finished laying out and hand back an inflated width.
  function computeNavTabs(navWidth) {
    if (!navWidth) return null
    const widths = TABS.map((_, i) => measureRefs.current[i]?.offsetWidth ?? 0)
    const moreWidth = moreProbeRef.current?.offsetWidth ?? 0
    // Probes render in the same commit as navWrapRef (siblings, earlier in
    // the JSX so they attach first), but if that ordering assumption is ever
    // wrong, all-zero widths would make totalAll look tiny and wrongly
    // return ALL_VISIBLE. Treat that as "not measured yet" instead of "fits".
    if (moreWidth === 0 && widths.every((w) => w === 0)) return null
    const gapTotal = NAV_GAP * Math.max(0, TABS.length - 1)
    const totalAll = widths.reduce((a, b) => a + b, 0) + gapTotal
    // Always reserve the More control's width + one gap before deciding
    // everything fits — otherwise "fits at bare navWidth" and "fits with the
    // button reserved" disagree right at the boundary and the layout
    // oscillates between showing and hiding the button.
    const budget = navWidth - moreWidth - NAV_GAP
    if (totalAll <= budget) return ALL_VISIBLE

    let sum = 0
    let k = 0
    while (k < TABS.length) {
      const next = sum + widths[k] + (k > 0 ? NAV_GAP : 0)
      if (next > budget) break
      sum = next
      k++
    }
    k = Math.max(1, k) // always show at least one tab

    let ids = TABS.slice(0, k).map((t) => t.id)
    if (!ids.includes(activeIdRef.current)) {
      // Promote the active tab: drop the last otherwise-visible tab instead.
      ids = ids.slice(0, -1)
      ids.push(activeIdRef.current)
    }
    const visibleSet = new Set(ids)
    return {
      visible: TABS.filter((t) => visibleSet.has(t.id)).map((t) => t.id),
      hidden: TABS.filter((t) => !visibleSet.has(t.id)).map((t) => t.id),
    }
  }
  computeRef.current = computeNavTabs

  // Mount detection MUST use a callback ref, not a mount-time useEffect.
  // <nav> lives inside <VaultGate>, which renders a loading spinner (not
  // `children`) until an async /api/vault/status fetch resolves — so the
  // real header/nav DOM doesn't attach during App's own first commit. A
  // useEffect/useLayoutEffect with `deps: []` (or `[tab]`, which also never
  // changes before mount) runs once at THAT commit, sees navWrapRef.current
  // still null, and never runs again — leaving navTabs stuck on its
  // ALL_VISIBLE default forever, correct-by-coincidence at wide widths and
  // silently wrong at narrow ones. A callback ref instead fires exactly when
  // React actually inserts (or removes) that DOM node, however many renders
  // of whatever ancestor that takes — so it reliably catches the real mount.
  const roCleanupRef = useRef(null)
  function measureAndApply(navWidth) {
    widthRef.current = navWidth
    const next = computeRef.current(navWidth)
    if (next && !navEqual(next, prevNavRef.current)) {
      prevNavRef.current = next
      setNavTabs(next)
    }
  }
  const navWrapCallbackRef = (node) => {
    if (roCleanupRef.current) {
      roCleanupRef.current()
      roCleanupRef.current = null
    }
    navWrapRef.current = node
    if (!node) return
    measureAndApply(node.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    // No rAF debounce here (unlike a continuous-drag resize storm, which
    // DataTable.jsx's own ResizeObserver effect debounces): the case this
    // needs to catch is the header's right-side controls (ConnStatus,
    // UpdateButton) growing once, asynchronously, shortly after this same
    // mount — their own fetches resolving after the initial paint. Adding
    // an extra rAF hop here means an extra frame where the stale (pre-growth)
    // tab list is what's on screen; applying the corrected width the moment
    // the observer reports it (still pre-paint, per the ResizeObserver spec)
    // closes that window instead of widening it.
    const ro = new ResizeObserver((entries) => {
      measureAndApply(entries[0].contentRect.width)
    })
    ro.observe(node)
    roCleanupRef.current = () => ro.disconnect()
  }

  // Recompute whenever the active tab changes (promotion depends on it). By
  // the time a user can switch tabs, the nav has already mounted via the
  // callback ref above, so a synchronous read here is safe. Skipped on the
  // very first render (the callback ref already measured that case) by
  // comparing against the id it ran with.
  const mountedTabRef = useRef(tab)
  useLayoutEffect(() => {
    if (mountedTabRef.current === tab) return
    mountedTabRef.current = tab
    const wrap = navWrapRef.current
    if (!wrap) return
    measureAndApply(wrap.getBoundingClientRect().width)
  }, [tab])

  // null (not yet measured) renders zero tabs rather than a guess — see the
  // navTabs useState comment above for why a guess is unsafe here.
  const visibleTabs = navTabs ? navTabs.visible.map((id) => TABS.find((t) => t.id === id)) : []
  const hiddenTabs = navTabs ? navTabs.hidden.map((id) => TABS.find((t) => t.id === id)) : []

  useEffect(() => {
    if (hiddenTabs.length === 0) setMenuOpen(false)
  }, [hiddenTabs.length])

  useEffect(() => {
    if (!menuOpen) return undefined
    const onDocClick = (e) => {
      if (menuRef.current?.contains(e.target) || moreBtnRef.current?.contains(e.target)) return
      setMenuOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        moreBtnRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <VaultGate>
      <div className="min-h-screen bg-bg text-txt">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-line-2 bg-bg/95 backdrop-blur sticky top-0 z-10">
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
              className="h-5 w-5 rounded"
            />
          </button>
          <strong className="tracking-tight shrink-0">Bloxsmith</strong>
          {/* Hidden measurement probes: same classes/text as the real tabs (using
              the heavier font-medium weight as a conservative overestimate) so
              offsetWidth reflects real rendered size. Never painted. */}
          <div aria-hidden="true" style={{ position: 'absolute', top: -9999, left: -9999, visibility: 'hidden', pointerEvents: 'none', display: 'flex', gap: `${NAV_GAP}px` }}>
            {TABS.map((t, i) => (
              <span key={t.id} ref={(el) => (measureRefs.current[i] = el)} className="px-3 py-1.5 rounded-lg text-[13px] font-medium whitespace-nowrap">
                {t.label}
              </span>
            ))}
            <span ref={moreProbeRef} className="px-3 py-1.5 rounded-lg text-[13px] font-medium whitespace-nowrap flex items-center gap-1">
              More <span aria-hidden="true">▾</span> 99
            </span>
          </div>
          {/* flex-1 min-w-0: this wrapper's own width comes from the header
              row's layout (container minus the other shrink-0 items), never
              from the nav/button content inside it — that's what keeps the
              measurement stable instead of feeding back into itself. The
              More button is a SIBLING of <nav>, not a child, and carries
              shrink-0: if it lived inside nav it could itself be clipped by
              the very overflow it's meant to reveal (the exact prior bug). */}
          <div ref={navWrapCallbackRef} className="flex-1 min-w-0 flex items-center gap-0.5">
            <nav className="flex gap-0.5 min-w-0">
              {visibleTabs.map((t) => (
                <a
                  key={t.id}
                  href={`#${t.id}`}
                  className={
                    'px-3 py-1.5 rounded-lg text-[13px] no-underline ' +
                    (t.id === tab
                      ? 'bg-line text-txt font-medium'
                      : 'text-muted hover:text-txt')
                  }
                >
                  {t.label}
                </a>
              ))}
            </nav>
            {hiddenTabs.length > 0 && (
              <div className="relative shrink-0">
                <button
                  ref={moreBtnRef}
                  type="button"
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                  aria-label={`${hiddenTabs.length} more tab${hiddenTabs.length === 1 ? '' : 's'}`}
                  onClick={() => setMenuOpen((v) => !v)}
                  className={
                    'px-3 py-1.5 rounded-lg text-[13px] flex items-center gap-1 whitespace-nowrap ' +
                    (menuOpen ? 'bg-line text-txt font-medium' : 'text-muted hover:text-txt')
                  }
                >
                  More <span aria-hidden="true">▾</span> {hiddenTabs.length}
                </button>
                {menuOpen && (
                  <div
                    ref={menuRef}
                    role="menu"
                    className="absolute left-0 top-full mt-1 min-w-[10rem] rounded-lg border border-border bg-card shadow-lg py-1 z-20"
                  >
                    {hiddenTabs.map((t) => (
                      <a
                        key={t.id}
                        href={`#${t.id}`}
                        role="menuitem"
                        onClick={() => setMenuOpen(false)}
                        className={
                          'block px-3 py-1.5 text-[13px] no-underline ' +
                          (t.id === tab ? 'bg-line text-txt font-medium' : 'text-muted hover:text-txt hover:bg-line/50')
                        }
                      >
                        {t.label}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <ConnStatus />
            <UpdateButton />
            <ThemeSwitch />
            <button
              onClick={() => setShowAccounts(true)}
              title="Settings"
              aria-label="Settings"
              className="w-8 h-8 rounded-lg border border-border bg-field text-muted hover:text-txt hover:border-border-hover"
            >
              ⋯
            </button>
            <a
              href="#provision"
              className="px-2.5 py-1.5 rounded-lg bg-accent border border-accent text-white text-sm font-medium no-underline"
            >
              + Provision
            </a>
          </div>
        </div>
        <Active />
        <Palette tabs={TABS} onPick={(id) => { location.hash = id }} />
        {showAccounts && <TenantManager onClose={() => setShowAccounts(false)} />}
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
