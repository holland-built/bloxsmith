import { FOCUS_RING } from './ui.jsx'

// The everyday jobs, always one click away: a rail beside the page from md up,
// a bar along the bottom on a phone. Everything else is under All pages.
const JOBS = [
  { id: 'home', label: 'Inbox', match: ['home'] },
  { id: 'selfservice', label: 'Get an address', match: ['selfservice'] },
  { id: 'overview', label: 'Reports', match: ['overview', 'daily'] },
  { id: 'chart', label: 'Charts', match: ['chart'] },
]

const linkCls = (on) => `${FOCUS_RING} no-underline ${on ? 'text-accent font-semibold border-accent' : 'text-muted border-transparent hover:text-txt'}`

export function JobRail({ tab }) {
  return (
    <nav aria-label="Jobs" data-job-rail="" className="hidden md:flex flex-col w-48 shrink-0 border-r border-border bg-card py-3 sticky top-[57px] self-start h-[calc(100vh-57px)]">
      {JOBS.map((j) => {
        const on = j.match.includes(tab)
        return (
          <a key={j.id} href={`#${j.id}`} aria-current={on ? 'page' : undefined} className={`px-4 py-2.5 text-copy border-l ${linkCls(on)}`}>
            {j.label}
          </a>
        )
      })}
    </nav>
  )
}

export function JobBar({ tab }) {
  return (
    <nav
      aria-label="Jobs"
      data-job-bar=""
      className="md:hidden fixed z-40 bottom-0 inset-x-0 grid grid-cols-4 border-t border-border bg-card"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {JOBS.map((j) => {
        const on = j.match.includes(tab)
        return (
          <a key={j.id} href={`#${j.id}`} aria-current={on ? 'page' : undefined} className={`h-14 px-1 grid place-items-center text-center text-note leading-tight border-t-2 ${linkCls(on)}`}>
            {j.label}
          </a>
        )
      })}
    </nav>
  )
}
