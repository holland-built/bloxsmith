// The confirm step for switching a read-only tenant to read-write on Provision.
// Its own file so #provision downloads it only after the switch is pressed.
import { useState } from 'react'
import { authFetch } from '../lib/authFetch.js'
import { writeFailureText } from '../lib/writeFailure.js'

export default function ReadOnlySwitch({ wt, onClose }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // The id of the tenant NAMED on screen is sent, not left for the server to
  // resolve: the active tenant is process-wide, and another tab could switch it
  // while this confirm is open. Without the id the server would mark whichever
  // tenant is active by then, not the one the operator just agreed to.
  const allow = async () => {
    setBusy(true); setErr('')
    const r = await authFetch('/api/vault/tenant-writable', { method: 'POST', body: JSON.stringify({ writable: true, id: wt.data.tenant }) })
    setBusy(false)
    if (r.ok && r.data?.ok) {
      onClose()
      wt.reload()
      // The tenant chip in the top bar shows this same permission.
      window.dispatchEvent(new Event('bx:write-target'))
    }
    else setErr(writeFailureText(r.status, r.data, 'change the write permission'))
  }

  return (
    <div className="mt-2">
      <p className="text-note mb-2" style={{ color: 'var(--color-warn)' }}>
        This lets Apply and teardown create and delete real DNS zones, subnets, address blocks, DHCP ranges and
        host records in {wt.name}.
        Only do this on a tenant you own. You can switch it back in Settings.
      </p>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={allow}
          className="px-2.5 py-1.5 rounded-control border text-copy disabled:opacity-50"
          style={{ borderColor: 'var(--color-crit)', color: 'var(--color-crit)' }}>
          {busy ? 'Saving…' : 'Yes, allow changes'}
        </button>
        <button type="button" disabled={busy} onClick={onClose}
          className="px-2.5 py-1.5 rounded-control border border-border text-copy">
          Cancel
        </button>
      </div>
      {err && <p className="text-note mt-2" style={{ color: 'var(--color-crit)' }}>{err}</p>}
    </div>
  )
}
