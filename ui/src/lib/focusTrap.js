// Keeps Tab inside a dialog. Every dialog in the app used to carry its own copy
// of this; one copy means a fix lands everywhere at once.
//
// The list of controls is read on every press, not captured on open, because
// dialogs add and remove controls while they are open (a preview image, a
// confirm step, a section switch).
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Call from the dialog's onKeyDown with the dialog panel element. Only the two
// ends need handling: everything between them is the browser's own Tab order.
// Shift+Tab from the panel itself (where focus lands on open) goes to the last
// control. A dialog with no visible control keeps focus on the panel.
export function trapTab(e, panel) {
  if (e.key !== 'Tab' || !panel) return
  const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null)
  if (!items.length) {
    e.preventDefault()
    panel.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const cur = panel.ownerDocument.activeElement
  if (e.shiftKey && (cur === first || cur === panel)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && cur === last) {
    e.preventDefault()
    first.focus()
  }
}

// The usual dialog keys: Escape closes, Tab stays inside. Escape is stopped
// here so it cannot also reach App.jsx's document-level Escape, which belongs
// to the group menus.
export function dialogKeyDown(e, panel, onClose) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    onClose()
    return
  }
  trapTab(e, panel)
}
