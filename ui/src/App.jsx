import Overview from './tabs/Overview.jsx'

const TABS = ['Overview', 'Network', 'DNS', 'Security', 'Infra']

export default function App() {
  return (
    <div className="min-h-screen bg-bg text-txt">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-line-2 bg-bg/95 backdrop-blur sticky top-0 z-10">
        <strong className="tracking-tight">◆ Bloxsmith</strong>
        <nav className="flex gap-0.5">
          {TABS.map((t) => (
            <a
              key={t}
              href="#"
              className={
                'px-3 py-1.5 rounded-lg text-[13px] no-underline ' +
                (t === 'Overview'
                  ? 'bg-line text-txt font-medium'
                  : 'text-muted hover:text-txt')
              }
            >
              {t}
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
      <Overview />
    </div>
  )
}
