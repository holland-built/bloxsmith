import { useMemo } from 'react'
import Tip from '../components/Tip.jsx'
import { formatTime } from '../lib/dates.js'

// "Updated 11:02 PM" at the top right of a page with live data: the time the
// page's own read last arrived, never the clock. `api` is that read, from
// useApi or useData. A failed refresh keeps the last good time and says so.
// Kept out of kit.jsx so the form pages that load kit do not also load Tip.
// It draws with Overview.css's pill (ov-pill, ov-live), so it sits inside an
// .ov-look and its page imports Overview.css, as DNS's always did.
export default function UpdatedPill({ api, tip, unavailable = 'Information is unavailable' }) {
  // A new payload object is a read that arrived; a re-render is not.
  const at = useMemo(() => (api.data ? new Date() : null), [api.data])
  const time = at ? formatTime(at) : null
  const failed = !!api.error && !api.loading
  const dot = failed ? 'down' : time ? '' : 'wait'
  const label = failed ? (time ? `Couldn't refresh · ${time}` : unavailable) : time ? `Updated ${time}` : 'Checking…'
  return (
    <Tip tip={tip || null} className="ov-pill" data-updated="">
      <span className={`ov-live ${dot}`} aria-hidden="true" />{label}
    </Tip>
  )
}
