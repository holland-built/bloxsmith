import { useEffect, useState } from 'react'
import Overview from './tabs/Overview.jsx'
import Daily from './tabs/Daily.jsx'
import Network from './tabs/Network.jsx'
import Dns from './tabs/Dns.jsx'
import Security from './tabs/Security.jsx'
import Infra from './tabs/Infra.jsx'
import Incidents from './tabs/Incidents.jsx'
import Audit from './tabs/Audit.jsx'

const TABS = [
  { id: 'overview', label: 'Overview', el: Overview },
  { id: 'daily', label: 'Daily', el: Daily },
  { id: 'network', label: 'Network', el: Network },
  { id: 'dns', label: 'DNS', el: Dns },
  { id: 'security', label: 'Security', el: Security },
  { id: 'infra', label: 'Infra', el: Infra },
  { id: 'incidents', label: 'Incidents', el: Incidents },
  { id: 'audit', label: 'Audit', el: Audit },
]

function hashTab() {
  const h = location.hash.replace('#', '')
  return TABS.some((t) => t.id === h) ? h : 'overview'
}

export default function App() {
  const [tab, setTab] = useState(hashTab)

  useEffect(() => {
    const on = () => setTab(hashTab())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const Active = TABS.find((t) => t.id === tab)?.el ?? Overview

  return (
    <div className="min-h-screen bg-bg text-txt">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-line-2 bg-bg/95 backdrop-blur sticky top-0 z-10">
        <strong className="tracking-tight">◆ Bloxsmith</strong>
        <nav className="flex gap-0.5">
          {TABS.map((t) => (
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
        <span className="flex-1" />
        <input
          placeholder="Search…  ⌘K"
          className="w-[190px] px-2.5 py-1.5 rounded-lg border border-[#2a2a2a] bg-[#141414] text-[#ddd] text-sm outline-none"
        />
        <button className="px-2.5 py-1.5 rounded-lg bg-accent border border-accent text-white text-sm font-medium">
          + Provision
        </button>
      </div>
      <Active />
    </div>
  )
}
