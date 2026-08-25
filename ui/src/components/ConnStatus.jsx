import { useEffect, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'

export default function ConnStatus() {
  const [locked, setLocked] = useState(false)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchErr, setSwitchErr] = useState('')
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

  // The build version used to be spelled out here as `· v{version}`, which on a
  // dev build renders "· vdev-4244bde" — a git sha, next to a tenant name, in
  // the one badge that is supposed to say who you are connected as. It reads
  // like part of the account. It is still in the "…" Settings sheet, which is
  // where a build number belongs.

  const tenants = status?.tenants ?? []
  const activeTenant = status?.active ?? null
  // Only worth opening for a choice. One tenant is not a choice, and a locked
  // vault has nothing to switch between.
  const canSwitch = !isLocked && tenants.length > 1

  const switchTenant = async (id) => {
    if (id === activeTenant || switching) return
    setSwitching(true)
    const r = await fetch('/api/vault/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const d = await r.json().catch(() => ({}))
    if (d.ok) {
      // RELOAD, deliberately. The server rotates its cache on a tenant switch
      // (main.go's authReset), so nothing stale is served — but every panel in
      // the browser keeps the PREVIOUS tenant's rows on screen until its own
      // poll comes round, which is 15s on some tabs and 60s on others. The
      // settings sheet's own tenant switch has always had this gap. A reader
      // watching numbers that belong to the account they just left cannot tell
      // that from a broken dashboard.
      window.location.reload()
      return
    }
    setSwitching(false)
    setSwitchErr(d.error || 'Could not switch tenant.')
  }

  if (!canSwitch) {
    return (
      <span className="text-caption text-muted flex items-center gap-1.5" title={title}>
        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
        {/* Below `lg` only the dot survives on the bar (the v11 A3 fold). The
            words it stands for are not lost: the same tenant is spelled out in
            the "…" Settings sheet, which is reachable at every width. The dot
            keeps its colour, so a locked vault or a dead feed is still visible
            on a phone. */}
        <span className="hidden lg:flex items-center gap-1.5">{label}</span>
      </span>
    )
  }

  return (
    <span className="relative text-caption text-muted flex items-center">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-control px-1 py-0.5 hover:bg-line/60 cursor-pointer"
        title={`${title} — click to switch tenant`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setSwitchErr(''); setOpen((o) => !o) }}
      >
        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
        <span className="hidden lg:flex items-center gap-1.5">{label}</span>
      </button>
      {open && (
        <>
          {/* Click-away, behind the menu. A menu that only closes by reselecting
              is a trap on a narrow screen. */}
          <button type="button" aria-label="Close tenant menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div role="listbox" className="absolute right-0 top-full mt-1.5 z-50 min-w-[190px] rounded-control border border-border bg-card shadow-lg py-1">
            {tenants.map((t) => {
              const isActive = t.id === activeTenant
              return (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  disabled={switching}
                  className={
                    'w-full text-left px-2.5 py-1.5 flex items-center gap-2 disabled:opacity-60 ' +
                    (isActive ? 'text-accent font-medium bg-line/50' : 'text-field-txt hover:bg-line/40')
                  }
                  onClick={() => switchTenant(t.id)}
                >
                  {/* The mark, not just the colour: the current row has to be
                      identifiable without relying on seeing a hue. */}
                  <span className="w-2.5 text-center">{isActive ? '✓' : ''}</span>
                  <span className="truncate">{t.label}</span>
                </button>
              )
            })}
            {switchErr && (
              <div className="px-2.5 py-1.5 text-caption" style={{ color: 'var(--color-crit)' }}>{switchErr}</div>
            )}
          </div>
        </>
      )}
    </span>
  )
}
