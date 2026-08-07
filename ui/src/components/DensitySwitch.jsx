import { DENSITIES, setDensity, useDensity } from '../lib/density.js'

// Sibling of ThemeSwitch, deliberately the same pill: both are whole-app modes
// that persist, so a second shape would imply a second kind of thing. Two cells
// instead of three, because density has no "system" to defer to.
//
// Like ThemeSwitch it lives in its own file and has two homes — the header bar
// at desk widths, and the Settings sheet below `lg` where the header folds it
// away — so neither can be the "real" one that gets fixed while the other rots.
//
// The icons say what the control does rather than naming it: three rows with
// air around them, three rows without. Same 24-box, same stroke weight, same
// three lines — only the spacing differs, which is the only thing the setting
// changes.
const ComfortableIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 5h16M4 12h16M4 19h16" />
  </svg>
)
const CompactIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 8h16M4 12h16M4 16h16" />
  </svg>
)

const ICONS = { comfortable: ComfortableIcon, compact: CompactIcon }
const LABELS = { comfortable: 'Comfortable', compact: 'Compact' }

export default function DensitySwitch({ className = 'flex' }) {
  const density = useDensity()
  return (
    <div className={`${className} items-center rounded-full border border-border bg-field p-0.5`}>
      {DENSITIES.map((id) => {
        const Icon = ICONS[id]
        return (
          <button
            key={id}
            onClick={() => setDensity(id)}
            title={`${LABELS[id]} spacing`}
            aria-label={`${LABELS[id]} density`}
            aria-pressed={density === id}
            className={`w-6 h-6 rounded-full flex items-center justify-center ${
              density === id ? 'bg-line text-txt' : 'text-dim hover:text-muted'
            }`}
          >
            <Icon />
          </button>
        )
      })}
    </div>
  )
}
