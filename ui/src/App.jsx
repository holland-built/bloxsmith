import { useEffect, useState } from 'react'
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
import VaultGate from './components/VaultGate.jsx'
import TenantManager from './components/TenantManager.jsx'
import { BrandLogoImg, BrandEdit } from './components/BrandLogo.jsx'

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

  return (
    <VaultGate>
      <div className="min-h-screen bg-bg text-txt">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-line-2 bg-bg/95 backdrop-blur sticky top-0 z-10">
          <BrandLogoImg
            domain={brandDomain}
            bust={logoBust}
            title="Edit brand"
            className="h-5 w-5 rounded cursor-pointer"
            onClick={() => setShowBrand(true)}
          />
          <strong className="tracking-tight">Bloxsmith</strong>
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
          <UpdateButton />
          <button
            onClick={() => setShowAccounts(true)}
            className="px-2 py-1 rounded-lg border border-border text-muted text-xs hover:text-txt hover:border-border-hover"
          >
            ⚙ Settings
          </button>
          <button
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
            className="w-[190px] text-left px-2.5 py-1.5 rounded-lg border border-border bg-field text-muted text-sm"
          >
            Jump to…&nbsp;&nbsp;⌘K
          </button>
          <a
            href="#provision"
            className="px-2.5 py-1.5 rounded-lg bg-accent border border-accent text-white text-sm font-medium no-underline"
          >
            + Provision
          </a>
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
