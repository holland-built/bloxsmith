import { useTheme } from '../lib/theme.jsx'

// Vercel-style segmented theme switcher: sun / moon / monitor in one pill.
// Distinct shape from the square kebab button so the two never read as twins.
//
// It lives in its own file because it now has two homes: the header bar at
// desk widths, and the Settings sheet below `lg`, where the header folds it
// away. Both render the same component, so the two can never drift apart —
// and neither can be the "real" one that got fixed while the other rotted.
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

export default function ThemeSwitch({ className = 'flex' }) {
  const { mode, setMode } = useTheme()
  const opts = [
    { id: 'light', Icon: SunIcon, label: 'Light' },
    { id: 'system', Icon: MonitorIcon, label: 'System' },
    { id: 'dark', Icon: MoonIcon, label: 'Dark' },
  ]
  return (
    <div className={`${className} items-center rounded-full border border-border bg-field p-0.5`}>
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
