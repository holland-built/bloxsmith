import { useEffect, useRef, useState } from 'react'

// The everyday jobs, always one click away: at the top of the side rail from
// md up, a bar along the bottom on a phone.
const JOBS = [
  { id: 'overview', label: 'Overview' },
  { id: 'selfservice', label: 'Get an address' },
  { id: 'automate', label: 'Automate' },
  { id: 'daily', label: 'Daily report' },
  { id: 'chart', label: 'Charts' },
]
const JOB_IDS = new Set(JOBS.map((j) => j.id))

const ICONS = {
  overview: 'M2.5 2.5h4.5v5h-4.5zM9 2.5h4.5v3H9zM9 7.5h4.5v6H9zM2.5 9.5h4.5v4h-4.5z',
  selfservice: 'M8 14s4.5-4 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10 8 14 8 14zM8 8.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
  automate: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
  daily: 'M3 2.5h10v11H3zM5.5 6h5M5.5 8.5h5M5.5 11h3',
  chart: 'M2.5 13.5h11M4.5 11V7.5M8 11V3.5M11.5 11V6',
  status: 'M1.5 8.5h3l2-5 3 9 2-4h3',
  inventory: 'M2.5 3h11v3.5h-11zM2.5 9.5h11V13h-11zM5 4.75h.01M5 11.25h.01',
  risk: 'M8 1.7 13 3.5v4c0 3.2-2.1 5.5-5 6.8-2.9-1.3-5-3.6-5-6.8v-4z',
  change: 'M2.5 5.5h9L9 3M13.5 10.5h-9L7 13',
  ask: 'M2.5 3h11v8H7l-3 2.5V11H2.5z',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.4-3.4',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  caret: 'M4 6l4 4 4-4',
}

export const NavIcon = ({ name, size = 16 }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
)

// Which groups are open, kept in this browser only (owner, 2026-11-09).
const OPEN_KEY = 'bloxsmith.nav.open'

function readOpen() {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

// THE SIDE RAIL (owner's pick, 2026-11-21). A slim column of icons that opens
// over the page on hover, keyboard focus or tap, so the content keeps the room.
// Inside it: the five everyday jobs, then the groups, each folding open or
// shut. The open groups are remembered, a job is not listed again inside its
// group, and the group holding the current page always opens. On a phone the
// header's All pages menu and the bottom bar (JobBar) do this job instead.
export function JobRail({ tab, groups, tabs, logo }) {
  const rest = groups.map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => !JOB_IDS.has(id)) })).filter((g) => g.tabIds.length)
  const groupOf = (id) => rest.find((g) => g.tabIds.includes(id))?.id
  const [open, setOpen] = useState(() => {
    const s = readOpen()
    if (groupOf(tab)) s.add(groupOf(tab))
    return s
  })
  // Tap to open on a touch screen; hover and keyboard focus are CSS.
  const [railOpen, setRailOpen] = useState(false)
  const railRef = useRef(null)
  // Reaching a page in a shut group (from search, a link or the back button)
  // opens that group, so the page you are on is always shown in the menu.
  const [seenTab, setSeenTab] = useState(tab)
  if (tab !== seenTab) {
    setSeenTab(tab)
    setRailOpen(false)
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
  useEffect(() => {
    if (!railOpen) return undefined
    const away = (e) => { if (!railRef.current?.contains(e.target)) setRailOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [railOpen])
  const toggle = (id) => {
    const n = new Set(open)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setOpen(n)
  }
  const labelOf = (id) => tabs.find((t) => t.id === id)?.label || id
  // Escape leaves the rail for the page, which is what lets it close while a
  // keyboard user is inside it.
  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return
    setRailOpen(false)
    if (railRef.current?.contains(document.activeElement)) document.querySelector('main')?.focus()
  }
  return (
    // The outer div is the column: a flex child of App's row, so it stretches to
    // the full height of the page and paints the card background and border all
    // the way down. The part inside stays one screen tall and sticky.
    <div ref={railRef} data-job-column="" className="frame-rail" data-open={railOpen ? '' : undefined} onKeyDown={onKeyDown}>
      <div className="frame-rail-inner">
        <div className="frame-rail-head">
          {logo}
          <strong className="frame-link-text">Bloxsmith</strong>
          <button type="button" className="frame-icon frame-rail-toggle" aria-label={railOpen ? 'Close menu' : 'Open menu'} aria-expanded={railOpen} onClick={() => setRailOpen((o) => !o)}>
            <NavIcon name={railOpen ? 'close' : 'menu'} />
          </button>
        </div>
        <nav aria-label="Pages" data-job-rail="" className="frame-nav">
          {JOBS.map((j) => (
            <a key={j.id} href={`#${j.id}`} aria-current={j.id === tab ? 'page' : undefined} className={`frame-link ${j.id === tab ? '' : 'text-muted'}`} title={j.label}>
              <NavIcon name={j.id} />
              <span className="frame-link-text">{j.label}</span>
            </a>
          ))}
          <div className="frame-nav-gap" />
          {rest.map((g) => {
            const isOpen = open.has(g.id)
            return (
              <div key={g.id} data-nav-group={g.id}>
                <button
                  type="button"
                  className="frame-link frame-group text-muted"
                  data-holds-page={g.tabIds.includes(tab) ? '' : undefined}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? `nav-${g.id}` : undefined}
                  onClick={() => toggle(g.id)}
                  title={g.label}
                >
                  <NavIcon name={g.id} />
                  {/* "Ask pages", not "Ask": the AI page's send button is already
                      called Ask, and two controls with one name cannot be told apart. */}
                  <span className="frame-link-text">{g.label}<span className="sr-only"> pages</span></span>
                  <span className="frame-fold" data-open={isOpen ? '' : undefined}><NavIcon name="caret" size={12} /></span>
                </button>
                {isOpen && (
                  <div id={`nav-${g.id}`} role="group" aria-label={g.label} className="frame-sub">
                    {g.tabIds.map((id) => (
                      <a key={id} href={`#${id}`} aria-current={id === tab ? 'page' : undefined} className={`frame-link frame-sublink ${id === tab ? '' : 'text-muted'}`}>
                        <span className="frame-link-text">{labelOf(id)}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      </div>
    </div>
  )
}

// The phone's bottom bar: an icon for each job, and the current page in words.
// The other labels stay available to screen readers and voice control.
export function JobBar({ tab }) {
  return (
    <nav aria-label="Jobs" data-job-bar="" className="frame-dock">
      {JOBS.map((j) => (
        <a key={j.id} href={`#${j.id}`} aria-current={j.id === tab ? 'page' : undefined} title={j.label} className="frame-dock-item">
          <NavIcon name={j.id} size={18} />
          <span>{j.label}</span>
        </a>
      ))}
    </nav>
  )
}
