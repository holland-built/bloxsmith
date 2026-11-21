import { useEffect, useRef, useState } from 'react'
import { PageHelp } from './ui.jsx'
import { OPEN_SEARCH } from './Palette.jsx'
import UpdateButton from './UpdateButton.jsx'
import ConnStatus, { RefreshControl } from './ConnStatus.jsx'
import OneBox from './OneBox.jsx'
import { JOBS } from '../lib/navJobs.js'
import { ThemeToggle } from './ThemeSwitch.jsx'
import { BrandLogoImg } from './BrandLogo.jsx'
import { SHELL_LOOKS, shellHref } from '../lib/shellLook.js'
import './shell.css'

// The three trial looks of the app's frame (?shell=a, b, c). Loaded only when
// one is on, CSS included, so the app without ?shell does not change.

const ICONS = {
  overview: 'M2.5 2.5h4.5v5h-4.5zM9 2.5h4.5v3H9zM9 7.5h4.5v6H9zM2.5 9.5h4.5v4h-4.5z',
  selfservice: 'M8 14s4.5-4 4.5-7.5a4.5 4.5 0 0 0-9 0C3.500 10 8 14 8 14zM8 8.200a1.700 1.700 0 1 0 0-3.400 1.700 1.700 0 0 0 0 3.400z',
  automate: 'M9 1.500 3.500 9H8l-1 5.500L12.500 7H8z',
  daily: 'M3 2.500h10v11H3zM5.500 6h5M5.500 8.500h5M5.500 11h3',
  chart: 'M2.500 13.500h11M4.500 11V7.500M8 11V3.500M11.500 11V6',
  status: 'M1.500 8.500h3l2-5 3 9 2-4h3',
  inventory: 'M2.500 3h11v3.500h-11zM2.500 9.500h11V13h-11zM5 4.750h.01M5 11.250h.01',
  risk: 'M8 1.700 13 3.500v4c0 3.200-2.100 5.500-5 6.800-2.900-1.300-5-3.600-5-6.800v-4z',
  change: 'M2.500 5.500h9l-2.500-2.500M13.500 10.500h-9l2.500 2.500',
  ask: 'M2.500 3h11v8H7l-3 2.500V11H2.500z',
  menu: 'M2.500 4h11M2.500 8h11M2.500 12h11',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.400-3.400',
  settings: 'M2 5h7M13 5h1M2 11h1M7 11h7M11 6.600a1.600 1.600 0 1 0 0-3.200 1.600 1.600 0 0 0 0 3.200zM5 12.600a1.600 1.600 0 1 0 0-3.200 1.600 1.600 0 0 0 0 3.200z',
  close: 'M3.500 3.500l9 9M12.500 3.500l-9 9',
  caret: 'M4 6l4 4 4-4',
}

const Icon = ({ name, size = 16 }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
)

const openSearch = () => window.dispatchEvent(new Event(OPEN_SEARCH))

const JOB_IDS = new Set(JOBS.map((j) => j.id))
const OPEN_KEY = 'bloxsmith.nav.open'

function readOpen() {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

// The side menu of looks a and c: the everyday jobs, then the folding groups.
// Same memory of open groups as today's menu, and the group holding the
// current page always opens.
function SideNav({ tab, groups, tabs }) {
  const rest = groups.map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => !JOB_IDS.has(id)) })).filter((g) => g.tabIds.length)
  const groupOf = (id) => rest.find((g) => g.tabIds.includes(id))?.id
  const [open, setOpen] = useState(() => {
    const s = readOpen()
    if (groupOf(tab)) s.add(groupOf(tab))
    return s
  })
  const [seenTab, setSeenTab] = useState(tab)
  if (tab !== seenTab) {
    setSeenTab(tab)
    const g = groupOf(tab)
    if (g && !open.has(g)) setOpen(new Set(open).add(g))
  }
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...open]))
    } catch {
      // Storage off or full: the groups just start shut next time.
    }
  }, [open])
  const toggle = (id) => {
    const n = new Set(open)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setOpen(n)
  }
  const labelOf = (id) => tabs.find((t) => t.id === id)?.label || id
  return (
    <nav aria-label="Pages" className="sx-nav">
      {JOBS.map((j) => (
        <a key={j.id} href={`#${j.id}`} aria-current={j.id === tab ? 'page' : undefined} className="sx-link" title={j.label}>
          <Icon name={j.id} />
          <span className="sx-link-text">{j.label}</span>
        </a>
      ))}
      <div className="sx-nav-gap" />
      {rest.map((g) => {
        const isOpen = open.has(g.id)
        const holdsPage = g.tabIds.includes(tab)
        return (
          <div key={g.id}>
            <button type="button" className="sx-link sx-group" data-holds-page={holdsPage ? '' : undefined} aria-expanded={isOpen} aria-controls={isOpen ? `sx-${g.id}` : undefined} onClick={() => toggle(g.id)} title={g.label}>
              <Icon name={g.id} />
              <span className="sx-link-text">{g.label}<span className="sr-only"> pages</span></span>
              <span className="sx-fold" data-open={isOpen ? '' : undefined}><Icon name="caret" size={12} /></span>
            </button>
            {isOpen && (
              <div id={`sx-${g.id}`} role="group" aria-label={g.label} className="sx-sub">
                {g.tabIds.map((id) => (
                  <a key={id} href={`#${id}`} aria-current={id === tab ? 'page' : undefined} className="sx-link sx-sublink">
                    <span className="sx-link-text">{labelOf(id)}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

// Every page at once: the phone menu in all looks, and the command bar's menu.
// A native modal dialog, so focus stays inside, Escape closes it and focus
// returns to the button that opened it.
function PagesDialog({ open, onClose, tab, groups, tabs }) {
  const ref = useRef(null)
  useEffect(() => {
    const d = ref.current
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  const labelOf = (id) => tabs.find((t) => t.id === id)?.label || id
  return (
    <dialog ref={ref} className="sx-sheet" aria-label="All pages" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      <div className="sx-sheet-inner">
        <div className="sx-sheet-head">
          <strong>All pages</strong>
          <button type="button" className="sx-icon" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sx-sheet-groups">
          {groups.map((g) => (
            <div key={g.id} role="group" aria-label={g.label}>
              <div className="sx-sheet-title"><Icon name={g.id} size={14} />{g.label}</div>
              {g.tabIds.map((id) => (
                <a key={id} href={`#${id}`} aria-current={id === tab ? 'page' : undefined} className="sx-link sx-sublink" onClick={onClose}>
                  <span className="sx-link-text">{labelOf(id)}</span>
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="sx-sheet-tools">
          <span>Automatic refresh</span>
          <RefreshControl shell />
          <ThemeToggle />
        </div>
      </div>
    </dialog>
  )
}

function BottomBar({ look, tab, onMenu, menuOpen }) {
  const jobs = JOBS.filter((j) => j.id !== 'daily')
  const items = look === 'b' ? [jobs[0], jobs[1], 'search', jobs[3]] : jobs
  return (
    <nav aria-label="Jobs" className="sx-bottom">
      {items.map((j) =>
        j === 'search' ? (
          <button key="search" type="button" className="sx-bottom-item" onClick={openSearch} aria-keyshortcuts="Meta+K Control+K">
            <Icon name="search" size={18} /><span>Search</span>
          </button>
        ) : (
          <a key={j.id} href={`#${j.id}`} aria-current={j.id === tab ? 'page' : undefined} className="sx-bottom-item">
            <Icon name={j.id} size={18} /><span>{j.id === 'chart' ? 'Charts' : j.label}</span>
          </a>
        ),
      )}
      <button type="button" className="sx-bottom-item" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={onMenu}>
        <Icon name="menu" size={18} /><span>Menu</span>
      </button>
    </nav>
  )
}

// The small floating switch between the trial looks.
function LookSwitch({ look, tab }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const btn = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  const name = SHELL_LOOKS.find((l) => l.id === look)?.label
  const href = (id) => shellHref(id, location.search, `#${tab}`)
  return (
    <div
      ref={box}
      className="sx-switch"
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); btn.current?.focus() } }}
    >
      {open && (
        <div className="sx-switch-list">
          {SHELL_LOOKS.map((l) => (
            <a key={l.id} href={href(l.id)} aria-current={l.id === look ? 'true' : undefined}>{l.label}</a>
          ))}
          <a href={href(null)}>Standard layout</a>
        </div>
      )}
      <button ref={btn} type="button" aria-label={`Layout: ${name}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Layout<span className="sx-switch-name">: {name}</span>
      </button>
    </div>
  )
}

export default function ShellFrame({ look, tab, groups, tabs, activeLabel, hasGroup, brandDomain, logoBust, onBrand, settingsBtnRef, settingsOpen, settingsNote, onSettings, mainRef, children }) {
  const [menuOpen, setMenuOpen] = useState(false)
  // Tap to open the rail on a touch screen; hover and focus are CSS.
  const [railOpen, setRailOpen] = useState(false)
  useEffect(() => {
    setMenuOpen(false)
    setRailOpen(false)
  }, [tab])

  const logo = (
    <button type="button" aria-label="Edit brand" title="Edit brand" onClick={onBrand} className="sx-logo">
      <BrandLogoImg domain={brandDomain} bust={logoBust} className="h-5 w-5 rounded-mark" />
    </button>
  )

  return (
    <div className="sx-root">
      {look !== 'b' && (
        <aside
          className="sx-side"
          data-open={railOpen ? '' : undefined}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || look !== 'c') return
            setRailOpen(false)
            if (e.currentTarget.contains(document.activeElement)) document.activeElement.blur()
          }}
        >
          <div className="sx-side-head">
            {logo}
            <strong className="sx-link-text">Bloxsmith</strong>
            {look === 'c' && (
              <button type="button" className="sx-icon sx-rail-toggle" aria-label={railOpen ? 'Close menu' : 'Open menu'} aria-expanded={railOpen} onClick={() => setRailOpen((o) => !o)}>
                <Icon name={railOpen ? 'close' : 'menu'} />
              </button>
            )}
          </div>
          <SideNav tab={tab} groups={groups} tabs={tabs} />
        </aside>
      )}
      <div className="sx-col">
        <header className="sx-top">
          <div className="sx-where">
            <span className="sx-phone-logo">{logo}</span>
            {look === 'b' && <strong className="sx-wordmark">Bloxsmith</strong>}
            <div className="sx-where-text">
              {look === 'b' && (
                <button type="button" className="sx-page-btn" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
                  {activeLabel}<Icon name="caret" size={12} />
                </button>
              )}
              <ConnStatus shell />
            </div>
          </div>
          {look === 'b' && <div className="sx-search"><OneBox /></div>}
          <div className="sx-tools">
            {look !== 'b' && (
              <button type="button" className="sx-find" onClick={openSearch} aria-keyshortcuts="Meta+K Control+K">
                <Icon name="search" /><span>Search or ask</span>
              </button>
            )}
            {look === 'b' && (
              <button type="button" className="sx-icon sx-phone-only" aria-label="Search" onClick={openSearch} aria-keyshortcuts="Meta+K Control+K"><Icon name="search" /></button>
            )}
            <UpdateButton />
            <RefreshControl shell />
            {hasGroup && <PageHelp key={tab} anchor={activeLabel} />}
            <ThemeToggle />
            <button
              ref={settingsBtnRef}
              type="button"
              onClick={onSettings}
              title={settingsNote ? `Settings — ${settingsNote.toLowerCase()}` : 'Settings'}
              aria-label="Settings"
              aria-description={settingsNote || undefined}
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              className="sx-icon sx-settings"
            >
              {settingsNote && <span aria-hidden="true" className="sx-dot" />}
              <Icon name="settings" />
            </button>
          </div>
        </header>
        <main ref={mainRef} tabIndex={-1} aria-label={`${activeLabel} tab`} className="sx-main">
          {children}
        </main>
      </div>
      <BottomBar look={look} tab={tab} menuOpen={menuOpen} onMenu={() => setMenuOpen(true)} />
      <PagesDialog open={menuOpen} onClose={() => setMenuOpen(false)} tab={tab} groups={groups} tabs={tabs} />
      <LookSwitch look={look} tab={tab} />
    </div>
  )
}
