// Delete with one "are you sure" step. Pressing Delete asks the server what the
// item is now and whether Bloxsmith made it; the step says so in one sentence,
// and only its own Delete button deletes. On a read-only tenant the check still
// runs; only the final Delete is off.
import { useId, useState } from 'react'
import { COLORS } from './ui.jsx'
import { checkDelete, confirmDelete, whoMade } from '../lib/madeDelete.js'

export default function DeleteCheck({ kind, id, what, ro, onDone }) {
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const sayId = useId()

  async function ask() {
    setBusy(true)
    setError(null)
    const r = await checkDelete(kind, id)
    setBusy(false)
    if (!r.ok) setError(r.data?.error || `HTTP ${r.status}`)
    else setCheck(r.data)
  }

  async function del() {
    setBusy(true)
    setError(null)
    const r = await confirmDelete(kind, id, check.confirm)
    setBusy(false)
    setCheck(null)
    if (!r.ok || r.data?.ok === false) setError(r.data?.error || `HTTP ${r.status}`)
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
        <div role="group" aria-labelledby={sayId}
          className="rounded-control border border-border px-3 py-2 flex flex-col gap-2 self-stretch"
          style={safe ? undefined : { borderColor: COLORS.warn }}>
          <p id={sayId} className="text-note text-txt">
            <span className="font-medium">{check.label}</span>
            <span className="block" style={{ color: safe || check.gone ? undefined : COLORS.warn }}>{whoMade(check)}</span>
          </p>
          {check.blocked && <p className="text-note" style={{ color: COLORS.warn }}>{check.blocked}</p>}
          <div className="flex gap-2">
            {!check.gone && !check.blocked && (
              <button type="button" disabled={busy || ro} onClick={del}
                className="text-note font-medium px-3 py-1 rounded-control"
                style={{ background: COLORS.crit, color: COLORS.onCrit }}>
                {busy ? 'Deleting…' : 'Delete it'}
              </button>
            )}
            <button type="button" onClick={() => setCheck(null)}
              className="text-note px-3 py-1 rounded-control border border-border text-txt">Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-note" style={{ color: COLORS.crit }}>{error}</p>}
    </div>
  )
}
