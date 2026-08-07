import { useEffect, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'

export default function ConnStatus() {
  const [locked, setLocked] = useState(false)
  const lastFetchRef = useRef(null)
  const [, forceTick] = useState(0)

  const { data: status, error: statusError } = useApi('/api/vault/status', { poll: 30000 })
  const { data: rows, error: dataError } = useApi('/api/data', { poll: 60000 })

  useEffect(() => {
    const onLocked = () => setLocked(true)
    window.addEventListener('bx:vault-locked', onLocked)
    return () => window.removeEventListener('bx:vault-locked', onLocked)
  }, [])

  useEffect(() => {
    if (status && (status.ready || status.vaultMode === false)) setLocked(false)
  }, [status])

  const FEED_KEYS = ['subnets', 'hosts', 'leases']
  const meta = rows?._meta || {}
  const totals = rows?._totals || {}

  const hasData =
    !dataError &&
    rows &&
    FEED_KEYS.some((k) => Array.isArray(rows[k]) && rows[k].length > 0)

  // A degraded/all-error /api/data payload must not present the same "no data"
  // pill as a genuinely empty tenant — dead feeds still say hasData===false,
  // so this checks the per-feed _meta and _totals.degraded that /api/data
  // ships specifically to tell the two apart.
  const feedsDegraded =
    !!dataError ||
    !!totals.degraded ||
    FEED_KEYS.some((k) => meta[k] === 'error')

  useEffect(() => {
    if (hasData) lastFetchRef.current = Date.now()
  }, [hasData])

  // Tick every 5s so the tooltip's "Xs ago" stays fresh.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [])

  const statusOk = status && (status.ready || status.vaultMode === false)
  const isLocked = locked || (status && status.ready === false) || (!status && statusError)

  let color = 'var(--color-crit)'
  let label = 'offline'
  if (isLocked) {
    color = 'var(--color-crit)'
    label = 'locked'
  } else if (statusOk && hasData) {
    color = 'var(--color-ok)'
    const active = status?.active
    const tenant = status?.tenants?.find((t) => t.id === active)
    label = tenant?.label || 'connected'
  } else if (statusOk && feedsDegraded) {
    color = 'var(--color-crit)'
    label = 'feed error'
  } else if (statusOk) {
    color = 'var(--color-warn)'
    label = 'no data'
  }

  const tenantName =
    status?.tenants?.find((t) => t.id === status?.active)?.label || status?.active || 'tenant'
  const secsAgo = lastFetchRef.current
    ? Math.round((Date.now() - lastFetchRef.current) / 1000)
    : null
  const title = `${tenantName} · last data fetch ${secsAgo === null ? 'never' : `${secsAgo}s ago`}`

  const version = status?.version ? String(status.version).replace(/^v/, '') : null

  return (
    <span className="text-[11px] text-muted flex items-center gap-1.5" title={title}>
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      {/* Below `lg` only the dot survives on the bar (the v11 A3 fold). The
          words it stands for are not lost: the same tenant and version are
          spelled out in the "…" Settings sheet, which is reachable at every
          width. The dot keeps its colour, so a locked vault or a dead feed is
          still visible on a phone. */}
      <span className="hidden lg:flex items-center gap-1.5">
        {label}
        {version && <span className="text-dim">· v{version}</span>}
      </span>
    </span>
  )
}
