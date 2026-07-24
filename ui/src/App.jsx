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
          <nav className="flex gap-0.5 min-w-0 overflow-x-auto no-scrollbar">
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
