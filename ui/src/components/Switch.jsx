import { FOCUS_RING } from './ui.jsx'

// An on/off switch: a button with role="switch", so a screen reader says
// "on" or "off" rather than "pressed". The label is the button's own text, so
// clicking the words flips it too.
export default function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 bg-transparent border-0 p-0 text-copy text-txt cursor-pointer rounded-control ${FOCUS_RING}`}
    >
      <span
        aria-hidden="true"
        className={`relative inline-block w-9 h-5 rounded-full border transition-colors motion-reduce:transition-none ${
          checked ? 'bg-accent border-accent' : 'bg-field border-field-border'
        }`}
      >
        <span
          className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-[left] motion-reduce:transition-none ${
            checked ? 'left-[18px] bg-on-accent' : 'left-0.5 bg-muted'
          }`}
        />
      </span>
      {label}
    </button>
  )
}
