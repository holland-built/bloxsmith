import { useEffect, useState } from 'react'
import { FOCUS_RING } from './ui.jsx'

// The everyday jobs, always one click away: at the top of the page menu from
// md up, a bar along the bottom on a phone.
const JOBS = [
  { id: 'overview', label: 'Overview' },
  { id: 'selfservice', label: 'Get an address' },
  { id: 'automate', label: 'Automate' },
  { id: 'daily', label: 'Daily report' },
  { id: 'chart', label: 'Charts' },
]
const JOB_IDS = new Set(JOBS.map((j) => j.id))

const linkCls = (on) => `${FOCUS_RING} no-underline ${on ? 'text-accent font-semibold border-accent' : 'text-muted border-transparent hover:text-txt'}`

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

// THE PAGE MENU (2026-11-09). Every page used to sit behind one "All pages"
// menu in the header, which the owner found odd. Of three versions built on
// the real page, the owner picked this one: the five everyday jobs on top, then
// the groups, each folding open or shut. Two fixes came with the pick: the
// open groups are remembered, and a job is not listed a second time inside its
// group. The group holding the page you are on always opens, so the current
// page is never hidden. On a phone the header's All pages menu and the bottom
// bar (JobBar) do this job instead.
export function JobRail({ tab, groups, tabs }) {
  const rest = groups.map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => !JOB_IDS.has(id)) })).filter((g) => g.tabIds.length)
  const groupOf = (id) => rest.find((g) => g.tabIds.includes(id))?.id
  const [open, setOpen] = useState(() => {
    const s = readOpen()
    if (groupOf(tab)) s.add(groupOf(tab))
    return s
  })
  // Reaching a page in a shut group (from search, a link or the back button)
  // opens that group, so the page you are on is always shown in the menu.
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
  const link = (id, text, indent) => {
    const on = id === tab
    return (
      <a key={id} href={`#${id}`} aria-current={on ? 'page' : undefined} className={`${indent ? 'pl-7' : 'pl-4'} pr-3 py-1.5 text-copy border-l ${linkCls(on)}`}>
        {text}
      </a>
    )
  }
  return (
    // The outer div is the column: a flex child of App's row, so it stretches to
    // the full height of the page and paints the card background and right
    // border all the way down. The nav inside stays one screen tall and sticky,
    // scrolling on its own. When the nav itself carried the background it was
    // one screen tall, and a long page showed the page background below it.
    <div data-job-column="" className="hidden md:block w-52 shrink-0 border-r border-border bg-card">
    <nav aria-label="Pages" data-job-rail="" className="flex flex-col py-2 sticky top-[57px] h-[calc(100vh-57px)] overflow-y-auto">
      {JOBS.map((j) => link(j.id, j.label))}
      <div className="border-t border-border my-2" />
      {rest.map((g) => {
        const isOpen = open.has(g.id)
        return (
          <div key={g.id} className="flex flex-col" data-nav-group={g.id}>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={isOpen ? `nav-${g.id}` : undefined}
              onClick={() => toggle(g.id)}
              className={`flex items-center justify-between px-4 py-1.5 text-copy font-semibold text-txt text-left cursor-pointer hover:bg-line ${FOCUS_RING}`}
            >
              {/* "Ask pages", not "Ask": the AI page's send button is already
                  called Ask, and two controls with one name cannot be told apart. */}
              <span>{g.label}<span className="sr-only"> pages</span></span>
              <span aria-hidden="true" className="text-muted">{isOpen ? '−' : '+'}</span>
            </button>
            {isOpen && (
              <div id={`nav-${g.id}`} role="group" aria-label={g.label} className="flex flex-col pb-1">
                {g.tabIds.map((id) => link(id, labelOf(id), true))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
    </div>
  )
}

export function JobBar({ tab }) {
  return (
    <nav
      aria-label="Jobs"
      data-job-bar=""
      className="md:hidden fixed z-40 bottom-0 inset-x-0 grid grid-cols-5 border-t border-border bg-card"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {JOBS.map((j) => {
        const on = j.id === tab
        return (
          <a key={j.id} href={`#${j.id}`} aria-current={on ? 'page' : undefined} className={`h-14 px-1 grid place-items-center text-center text-note leading-tight border-t-2 ${linkCls(on)}`}>
            {j.label}
          </a>
        )
      })}
    </nav>
  )
}
