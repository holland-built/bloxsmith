import './Looks.css'

const OPTIONS = [
  { id: 'none', full: "Today's page", short: 'Today' },
  { id: 'a', full: 'Command center', short: 'Command' },
  { id: 'b', full: 'Live wall', short: 'Wall' },
  { id: 'c', full: 'Morning briefing', short: 'Briefing' },
]

// The small floating control for comparing the trial looks. It only appears
// when the address carries ?variant=, so nobody meets it by accident.
export default function LookSwitcher({ current }) {
  return (
    <nav className="lk-switch" aria-label="Try a look for this page">
      {OPTIONS.map((o) => (
        <a key={o.id} href={`#overview?variant=${o.id}`} aria-label={o.full} aria-current={current === o.id ? 'page' : undefined}>
          <span className="lk-full">{o.full}</span>
          <span className="lk-short">{o.short}</span>
        </a>
      ))}
    </nav>
  )
}
