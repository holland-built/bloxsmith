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

  const hasData =
    !dataError &&
    rows &&
    ['subnets', 'hosts', 'leases'].some((k) => Array.isArray(rows[k]) && rows[k].length > 0)

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
      {label}
      {version && <span className="text-dim">· v{version}</span>}
    </span>
  )
}
