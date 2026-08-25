import { useRef, useEffect } from 'react'
import { CONTROL_HELP } from '../lib/controlHelp.js'

// One dialog naming every control in the app header.
//
// WHY A DIALOG AND NOT SIX TOOLTIPS. Six tooltips is what shipped — every
// control in the header carries a `title=`, and the reported symptom ("I didn't
// know what the compact was at the top") is what that affordance is worth. It
// requires hover, which does not exist on touch; it requires knowing there is
// something to hover over, which is the exact knowledge that is missing; and it
// shows one control at a time, so the row can never be read as a row. One
// dialog, opened deliberately, answers "what is all this" in a single glance.
//
// WHY THE MODAL MACHINERY IS COPIED, NOT INVENTED. TenantManager.jsx already
// solved this — dialog role, focus onto the panel rather than onto its first
// button, a Tab trap re-read on every press, Escape stopped so it cannot also
// reach App.jsx's document-level Escape (which belongs to the nav menus), and
// focus return owned by App.jsx because this component is unmounted by the time
// the focus has to land. Every one of those is a decision with a reason behind
// it in that file. A second, subtly different dialog in the same header would
// be the version that rots.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function HeaderHelp({ onClose }) {
  const panelRef = useRef(null)

  // Focus goes to the panel, not to its ✕: what a screen reader then reads is
  // the dialog and its name, rather than "Close button" with no idea what would
  // be closed. Same choice, same reason, as the settings sheet.
  useEffect(() => { panelRef.current?.focus() }, [])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!items.length) {
      e.preventDefault()
      panelRef.current.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const cur = document.activeElement
    if (e.shiftKey && (cur === first || cur === panelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hh-title"
        tabIndex={-1}
        className="w-[420px] max-w-full max-h-[80vh] overflow-y-auto bg-card border border-card-border rounded-surface p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-4">
          <h2 id="hh-title" className="text-body font-semibold">What these controls do</h2>
          <span className="flex-1" />
          <button className="text-muted text-body" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* A description list, because that is what this is: a term and what it
            means, six times. The dictionary's key order is the header's own
            left-to-right order (held there by controlHelp.test.js), so the list
            can be read against the row it describes without hunting. */}
        <dl className="m-0">
          {Object.entries(CONTROL_HELP).map(([id, { label, what }]) => (
            <div key={id} className="mb-3 last:mb-0">
              <dt className="text-caption font-semibold text-field-txt">{label}</dt>
              <dd className="m-0 mt-0.5 text-caption leading-relaxed text-muted">{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
