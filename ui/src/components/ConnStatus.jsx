import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'

// Which tenant a change would land in, and whether it may be changed.
//
// NOT useApi, deliberately. This is a permission verdict that sits beside a
// tenant name, and useApi's guard is per url, not per request: a poll and a
// refetch for the same url can both be in flight and the older answer can land
// last, putting a revoked "Changes allowed" back on screen. So each read is
// numbered here and only the newest answer is kept. Two more rules follow from
// what the words are for:
//
//   - a read that FAILS discards the old verdict (the chip says "Can't tell"),
//     rather than leaving the last good one looking current; and
//   - when Settings or Provision has just granted or revoked, `bx:write-target`
//     hides the verdict until the re-read lands, so the old one is not shown
//     for even the moment the new one is in flight.
function useWriteTarget() {
  const [state, setState] = useState({ checking: true, data: null, error: false })
  const asked = useRef(0)
  const read = useCallback((hide) => {
    const mine = ++asked.current
    if (hide) setState({ checking: true, data: null, error: false })
    fetch('/api/vault/write-target', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => { if (mine === asked.current) setState({ checking: false, data, error: false }) })
      .catch(() => { if (mine === asked.current) setState({ checking: false, data: null, error: true }) })
  }, [])
  useEffect(() => {
    read(false)
    const id = setInterval(() => read(false), 30000)
    const on = () => read(true)
    window.addEventListener('bx:write-target', on)
    return () => {
      clearInterval(id)
      window.removeEventListener('bx:write-target', on)
    }
  }, [read])
  return state
}

export default function ConnStatus() {
  const [locked, setLocked] = useState(false)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchErr, setSwitchErr] = useState('')
  const lastFetchRef = useRef(null)
  const [, forceTick] = useState(0)

  const { data: status, error: statusError } = useApi('/api/vault/status', { poll: 30000 })
  // ADOPTS, because this dot and the Overview tab want the same 294KB and used
  // to fetch it separately — this one at t=39ms and Overview at t=331ms on every
  // load, measured 2026-08-27. Whichever of the two asks second now takes the
  // other's answer. The window is 2000ms: an order of magnitude above the
  // measured 261ms gap between the two mounts, and far below both poll intervals
  // (60s here, 30s there), so it collapses the duplicate without ever merging
  // two intended poll cycles into one.
  //
  // Nothing about this dot's own freshness claim changes: it reports when data
  // was last SEEN, and an adopted result was seen just as recently as a fetched
  // one — more recently, in fact, than the request this call site no longer makes.
  const { data: rows, error: dataError } = useApi('/api/data', { poll: 60000, adoptIfFresherThan: 2000 })

  // The write state sits beside the tenant name because it is the one fact an
  // operator needs before pressing Provision.
  const write = useWriteTarget()

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

  // The tenant's NAME and its STATE are two facts and the chip says both. They
  // used to share one slot, so a failing feed or an empty estate replaced the
  // name with "feed error" or "no data" — and once the write words moved in
  // beside it, "feed error · Changes allowed" named no tenant at all, which is
  // the one thing a permission verdict must never leave out.
  let color = 'var(--color-crit)'
  let stateWord = 'offline'
  let stateTone = 'text-crit'
  if (isLocked) {
    stateWord = 'locked'
  } else if (statusOk && hasData) {
    color = 'var(--color-ok)'
    stateWord = ''
  } else if (statusOk && feedsDegraded) {
    stateWord = 'feed error'
  } else if (statusOk) {
    color = 'var(--color-warn)'
    stateWord = 'no data'
    stateTone = 'text-warn'
  }
  // The name, when the vault can say which tenant is active.
  const knownName = status?.tenants?.find((t) => t.id === status?.active)?.label || ''

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

  // What a write would do, in words. Nothing is said until there is an answer,
  // and a failed read or `known: false` is "Can't tell" — never the last good
  // verdict, and never read-only. A locked or offline tenant says so in its state
  // word already and gets no permission words at all.
  let writeWords = ''
  let writeTone = 'text-muted'
  if (statusOk && !isLocked) {
    const writeTarget = write.data
    if (write.checking) {
      // Nothing is said until there is an answer to say.
    } else if (write.error || !writeTarget || writeTarget.known !== true) {
      writeWords = "Can't tell"
      writeTone = 'text-crit'
    } else {
      // A CSP account switch moves where a change lands without moving the
      // tenant named here: the write target's id is `<tenant>/<account>`, with
      // `-` for no switch. Its label is the base tenant's, so the id is what
      // tells them apart, and "Changes allowed" beside the wrong name would be
      // a false statement. Settings names the account.
      const switched = typeof writeTarget.tenant === 'string' && !writeTarget.tenant.endsWith('/-')
      const elsewhere = switched ? ' in another account' : ''
      writeWords = (writeTarget.writable ? 'Changes allowed' : 'Read-only') + elsewhere
      writeTone = writeTarget.writable ? 'text-warn' : 'text-muted'
    }
  }

  // The name beside a permission verdict, always. The vault names the active
  // tenant when it has a list; a single-key server has none, and then the write
  // target's own label stands in, and failing that the chip says "This
  // connection" — a verdict with no subject is the one thing it must not show.
  // With nothing to say about permission, a healthy single-key server is simply
  // "connected" and a failing one is its state word alone.
  const shownName =
    knownName ||
    (write.data && write.data.label) ||
    (writeWords ? 'This connection' : stateWord ? '' : 'connected')

  // Name over state below `lg`, on one line above it. The name truncates: a long
  // one must never push Settings and Provision off a 390px screen. The state
  // wraps on a phone instead of truncating, however many lines it takes,
  // because "Changes allowed in another account" cut to "Changes…" would hide
  // the one part that matters before Provision is pressed.
  const body = (
    <>
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="flex flex-col items-start min-w-0 leading-tight lg:flex-row lg:items-center lg:gap-2">
        {shownName && (
          <span className="truncate max-w-[56px] min-[360px]:max-w-[96px] lg:max-w-[220px] text-copy font-medium text-txt">{shownName}</span>
        )}
        {stateWord && (
          <span
            data-state
            className={`truncate max-w-[56px] min-[360px]:max-w-[96px] lg:max-w-[220px] ${shownName ? 'text-note' : 'text-copy font-medium'} ${stateTone}`}
          >
            {stateWord}
          </span>
        )}
        {writeWords && (
          <span data-write className={`break-words lg:truncate max-w-[56px] min-[360px]:max-w-[96px] min-[380px]:max-w-[112px] lg:max-w-[220px] text-note ${writeTone}`}>{writeWords}</span>
        )}
      </span>
      {/* A chip that opens a tenant list says so; one tenant is not a choice. */}
      {canSwitch && (
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-dim">
          <path d="M4 6l4 4 4-4" />
        </svg>
      )}
    </>
  )
  const chipCls = 'flex items-center gap-2 min-w-0 min-h-9 lg:h-8 py-1 lg:py-0 px-2.5 rounded-control border border-border bg-field'

  if (!canSwitch) {
    return (
      <span className={chipCls} title={`${title}${writeWords ? ` · ${writeWords}` : ''}`}>
        {body}
      </span>
    )
  }

  return (
    <span className="relative flex items-center min-w-0">
      <button
        type="button"
        className={chipCls + ' cursor-pointer hover:border-border-hover'}
        title={`${title}${writeWords ? ` · ${writeWords}` : ''} — click to switch tenant`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setSwitchErr(''); setOpen((o) => !o) }}
      >
        {body}
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
                    (isActive ? 'text-link font-medium bg-line/50' : 'text-field-txt hover:bg-line/40')
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
              <div className="px-2.5 py-1.5 text-note" style={{ color: 'var(--color-crit)' }}>{switchErr}</div>
            )}
          </div>
        </>
      )}
    </span>
  )
}
