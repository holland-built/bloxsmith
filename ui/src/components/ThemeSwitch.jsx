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

// One button for the header bar: shows the icon of the theme you are in and
// flips to the other one. "System" is a third choice that needs a home of its
// own, so it stays in Settings, Appearance, on the three-way switch below.
// Named "Switch to … mode" on purpose: the Settings switch owns the names
// "Light theme" and "Dark theme", and the specs find those by name.
//
// Hidden under 380px: with a long tenant name and an update ready the bar is
// already 14px too wide at 360 and 320, and Settings still has the switch.
export function ThemeToggle({ className = '' }) {
  const { effective, setMode } = useTheme()
  const toLight = effective === 'dark'
  const label = toLight ? 'Switch to light mode' : 'Switch to dark mode'
  return (
    <button
      type="button"
      data-theme-toggle
      onClick={() => setMode(toLight ? 'light' : 'dark')}
      title={label}
      aria-label={label}
      className={`hidden min-[380px]:inline-grid w-8 h-8 place-items-center rounded-control border border-border bg-field text-muted hover:text-txt hover:border-border-hover ${className}`}
    >
      {toLight ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

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
          aria-pressed={mode === id}
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
