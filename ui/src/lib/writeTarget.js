import { useEffect, useState } from 'react'
import { authFetch } from './authFetch.js'

// Whether the active tenant takes changes. The server refuses every write to a
// read-only tenant (go/internal/server/writelock.go), so a page that shows a
// write button asks this first and says why the button is off, rather than
// letting a click fail. Unknown is not read-only: the server decides then.
export function useReadOnly() {
  const [state, setState] = useState({ readOnly: false, name: '' })
  useEffect(() => {
    let live = true
    const load = async () => {
      const r = await authFetch('/api/vault/write-target', { cache: 'no-store' })
      const d = r.ok ? r.data : null
      if (live) setState({ readOnly: !!(d && d.known && d.writable === false), name: d?.label || d?.tenant || 'This tenant' })
    }
    load()
    // Provision's "Switch to read-write" fires this when the permission changes.
    window.addEventListener('bx:write-target', load)
    return () => { live = false; window.removeEventListener('bx:write-target', load) }
  }, [])
  return state
}
