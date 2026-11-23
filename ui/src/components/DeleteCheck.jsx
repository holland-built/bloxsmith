// Delete with one "are you sure" step. Pressing Delete asks the server what the
// item is now and whether Bloxsmith made it; the step says so in one sentence,
// and only its own Delete button deletes. On a read-only tenant the check still
// runs; only the final Delete is off.
import { useEffect, useId, useRef, useState } from 'react'
import { COLORS } from './ui.jsx'
import { checkDelete, confirmDelete, whoMade } from '../lib/madeDelete.js'
import { failureText } from '../lib/api.js'

// The "are you sure" box: a separate red button, a Cancel, and no timer. With
// takeFocus, keyboard focus lands on Cancel, so a second Enter cannot delete,
// and Cancel hands focus back to the button that opened the box.
export function ConfirmStep({ warn, note, yesLabel, showYes = true, yesDisabled, onYes, onCancel, takeFocus, children }) {
  const sayId = useId()
  const cancelRef = useRef(null)
  const backRef = useRef(null)
  useEffect(() => {
    if (!takeFocus) return
    backRef.current = document.activeElement
    cancelRef.current?.focus()
  }, [takeFocus])
  return (
    <div role="group" aria-labelledby={sayId}
      className="rounded-control border border-border px-3 py-2 flex flex-col gap-2 self-stretch"
      style={warn ? { borderColor: COLORS.warn } : undefined}>
      <p id={sayId} className="text-note text-txt">{children}</p>
      {note && <p className="text-note" style={{ color: COLORS.warn }}>{note}</p>}
      <div className="flex gap-2">
        {showYes && (
          <button type="button" disabled={yesDisabled} onClick={onYes}
            className="text-note font-medium px-3 py-1 rounded-control"
            style={{ background: COLORS.crit, color: COLORS.onCrit }}>
            {yesLabel}
          </button>
        )}
        <button ref={cancelRef} type="button" onClick={() => { onCancel(); backRef.current?.focus?.() }}
          className="text-note px-3 py-1 rounded-control border border-border text-txt">Cancel</button>
      </div>
    </div>
  )
}

export default function DeleteCheck({ kind, id, what, ro, onDone }) {
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function ask() {
    setBusy(true)
    setError(null)
    const r = await checkDelete(kind, id)
    setBusy(false)
    if (!r.ok) setError(r.data?.error || failureText(r.status, 'check this delete'))
    else setCheck(r.data)
  }

  async function del() {
    setBusy(true)
    setError(null)
    const r = await confirmDelete(kind, id, check.confirm)
    setBusy(false)
    setCheck(null)
    if (!r.ok || r.data?.ok === false) setError(r.data?.error || failureText(r.status, 'delete this item'))
    onDone?.(r)
  }

  const safe = check?.made && !check?.blocked
  return (
    <div className="flex flex-col items-end gap-1" data-delete-check={id}>
      {!check && (
        <button type="button" disabled={busy} onClick={ask} aria-label={what ? `Delete ${what}` : undefined}
          className="text-note px-2 py-1 rounded-control border border-border text-txt hover:border-border-hover">
          {busy ? 'Checking…' : 'Delete'}
        </button>
      )}
      {check && (
        <ConfirmStep warn={!safe} note={check.blocked} showYes={!check.gone && !check.blocked}
          yesLabel={busy ? 'Deleting…' : 'Delete it'} yesDisabled={busy || ro} onYes={del} onCancel={() => setCheck(null)}>
          <span className="font-medium">{check.label}</span>
          <span className="block" style={{ color: safe || check.gone ? undefined : COLORS.warn }}>{whoMade(check)}</span>
        </ConfirmStep>
      )}
      {error && <p role="alert" className="text-note" style={{ color: COLORS.crit }}>{error}</p>}
    </div>
  )
}
