import { useEffect, useRef, useState } from 'react'
import { FeedUnavailable } from './ui.jsx'
import ThemeSwitch from './ThemeSwitch.jsx'
import DensitySwitch from './DensitySwitch.jsx'
import { UpdateCheck } from './UpdateButton.jsx'
import { CONTROL_HELP } from '../lib/controlHelp.js'

const vpost = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
    .catch(() => ({ ok: false, data: { error: 'network error' } }))

const inCls =
  'w-full px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none focus:border-accent'
const rowBtn = 'flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-sm text-field-txt hover:bg-line'
const miniBtn = 'px-2 py-1 rounded-lg border border-border text-[11px] text-muted hover:text-txt hover:border-border-hover'

// Everything that can hold focus inside the sheet, in document order. Read
// fresh on every Tab because this sheet swaps whole sections in and out (add a
// connection, replace a key, confirm a removal) — a list captured on open would
// describe a sheet that is no longer on screen.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function TenantManager({ onClose }) {
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [accountsError, setAccountsError] = useState(null)
  const [dashToken, setDashToken] = useState(() => localStorage.getItem('dashToken') || '')
  const [confirmRm, setConfirmRm] = useState(null)
  const [locking, setLocking] = useState(false)
  const [switchingAcct, setSwitchingAcct] = useState(false)
  const [writeTarget, setWriteTarget] = useState(null)
  const [writeTargetError, setWriteTargetError] = useState(null)
  const [confirmGrant, setConfirmGrant] = useState(false)
  const [grantBusy, setGrantBusy] = useState(false)
  const [grantErr, setGrantErr] = useState('')

  const [add, setAdd] = useState({ open: false, label: '', key: '', groq: '', err: '', busy: false, test: '' })
  const [edit, setEdit] = useState(null) // { id, label, key, err, busy, test }

  const authHeaders = () => {
    const t = localStorage.getItem('dashToken')
    return t ? { 'X-Auth-Token': t } : {}
  }

  const load = () => {
    // A failed status read must not read as "no tenants saved" — that's a
    // real answer ("you have zero"), this is "we don't know".
    fetch('/api/vault/status', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setStatus(d); setStatusError(false) })
      .catch(() => setStatusError(true))
    // Which tenant a write would land in, and whether it has been opted in.
    // Three outcomes, kept distinct: writable, read-only, and "we could not
    // work out where a write would go" — the last is not read-only, it is
    // unknown, and it must not render as though we checked and it was fine.
    fetch('/api/vault/write-target', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setWriteTarget(d); setWriteTargetError(null) })
      .catch(() => setWriteTargetError('Could not read the write permission — retry.'))
    // go/internal/server/account.go:51 already computes {error,status} on a CSP
    // failure (HTTP 200, accounts:[]) — read and surface them instead of
    // silently collapsing to an empty switcher indistinguishable from "no
    // other accounts".
    fetch('/api/accounts', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { setAccounts(d.accounts || []); setAccountsError(d && d.error ? d.error : null) })
      .catch(() => setAccountsError('network error'))
  }

  useEffect(() => { load() }, [])

  // ---- modal behaviour -----------------------------------------------------
  //
  // This sheet is the only route to tenant switching, the version, the theme
  // switch and the density switch below `lg`, and it shipped as a bare
  // div.fixed: no dialog role, no focus move, no trap, and Escape did nothing.
  // Measured before this change: 177 Tab presses from the "…" that opens it to
  // its own ✕. On a phone that is not a slow route, it is no route.
  //
  // Focus goes to the panel itself rather than to the first control, so what a
  // screen reader reads on open is the dialog and its name, not "Close button"
  // with no idea what would be closed. App.jsx owns the other half — the
  // background goes inert, and focus returns to the "…" on close.
  const panelRef = useRef(null)
  useEffect(() => { panelRef.current?.focus() }, [])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      // Stopped here so it cannot also reach App.jsx's document-level Escape,
      // which is the group menus' and has no business firing off this one.
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!items.length) {
      e.preventDefault()
      panelRef.current.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const cur = document.activeElement
    // Only the two ends need handling: everything between them is the
    // browser's own Tab order, which is already correct.
    if (e.shiftKey && (cur === first || cur === panelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const tenants = (status && status.tenants) || []
  const activeId = status && status.active

  const saveToken = (v) => {
    setDashToken(v)
    if (v) localStorage.setItem('dashToken', v)
    else localStorage.removeItem('dashToken')
  }

  const setActive = async (id) => {
    if (id === activeId) return
    setSwitchingAcct(true)
    const { ok, data } = await vpost('/api/vault/active', { id })
    setSwitchingAcct(false)
    if (ok && data.ok) load()
  }

  const switchCspAccount = async (id) => {
    const r = await fetch('/api/switch-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const d = await r.json().catch(() => ({}))
    if (d.ok) window.location.reload()
  }

  const remove = async (id) => {
    await vpost('/api/vault/tenant-remove', { id })
    setConfirmRm(null)
    load()
  }

  const submitAdd = async () => {
    if (!add.key) return
    setAdd((a) => ({ ...a, err: '', busy: true }))
    const { ok, data } = await vpost('/api/vault/tenant', { label: add.label, key: add.key, groq: add.groq || undefined })
    if (ok && data.ok) {
      setAdd({ open: false, label: '', key: '', groq: '', err: '', busy: false, test: '' })
      load()
    } else {
      setAdd((a) => ({ ...a, busy: false, err: data.error || 'Could not add connection.' }))
    }
  }

  const testAddKey = async () => {
    if (!add.key) return
    setAdd((a) => ({ ...a, test: 'Testing…' }))
    const { ok, data } = await vpost('/api/vault/test-key', { key: add.key })
    // unverified: the request never reached CSP (offline/VPN/proxy/timeout) —
    // the key was never judged, so this must not read as "rejected".
    const test =
      ok && data.ok
        ? 'Key valid' + (data.name ? ' — ' + data.name : '')
        : data.unverified
          ? 'Unverified: could not verify — check connectivity and try again'
          : 'Invalid: ' + (data.error || 'rejected')
    setAdd((a) => ({ ...a, test }))
  }

  const openEdit = (t) => setEdit({ id: t.id, label: t.label, key: '', err: '', busy: false, test: '' })

  const submitEdit = async () => {
    if (!edit.key) return
    setEdit((e) => ({ ...e, err: '', busy: true }))
    const { ok, data } = await vpost('/api/vault/tenant-update', { id: edit.id, label: edit.label, key: edit.key })
    if (ok && data.ok) {
      setEdit(null)
      load()
    } else {
      setEdit((e) => ({ ...e, busy: false, err: data.error || 'Could not replace key.' }))
    }
  }

  const testEditKey = async () => {
    if (!edit.key) return
    setEdit((e) => ({ ...e, test: 'Testing…' }))
    const { ok, data } = await vpost('/api/vault/test-key', { key: edit.key })
    // unverified: the request never reached CSP (offline/VPN/proxy/timeout) —
    // the key was never judged, so this must not read as "rejected".
    const test =
      ok && data.ok
        ? 'Key valid' + (data.name ? ' — ' + data.name : '')
        : data.unverified
          ? 'Unverified: could not verify — check connectivity and try again'
          : 'Invalid: ' + (data.error || 'rejected')
    setEdit((e) => ({ ...e, test }))
  }

  // Grant or revoke write permission for the tenant a write would currently
  // land in. No id is sent: the server resolves the same identity it enforces
  // against, so the UI cannot grant permission for a different tenant than the
  // one it is showing.
  const setWritable = async (on) => {
    setGrantBusy(true)
    setGrantErr('')
    const { ok, data } = await vpost('/api/vault/tenant-writable', { writable: on })
    setGrantBusy(false)
    setConfirmGrant(false)
    if (ok && data.ok) load()
    else setGrantErr(data.error || 'Could not change the write permission.')
  }

  const lockNow = async () => {
    setLocking(true)
    await fetch('/api/vault/lock', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: '{}' })
    setLocking(false)
    window.dispatchEvent(new Event('bx:vault-locked'))
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tm-title"
        tabIndex={-1}
        className="w-[420px] max-w-full max-h-[80vh] overflow-y-auto bg-card border border-card-border rounded-card p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-4">
          <h2 id="tm-title" className="text-sm font-semibold">Settings</h2>
          <span className="flex-1" />
          <button className="text-muted text-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!add.open && !edit && (
          <>

          </>
        )}

        {add.open ? (
          <div>
            <h3 className="text-xs font-semibold mb-2">Add a connection</h3>
            <label htmlFor="tm-add-key" className="block text-[11px] text-dim mb-1">Infoblox API key</label>
            <input
              id="tm-add-key"
              className={inCls}
              type="password"
              value={add.key}
              onChange={(e) => setAdd((a) => ({ ...a, key: e.target.value, test: '' }))}
              placeholder="paste token"
              autoFocus
            />
            <label htmlFor="tm-add-label" className="block text-[11px] text-dim mt-2 mb-1">Name (optional)</label>
            <input id="tm-add-label" className={inCls} value={add.label} onChange={(e) => setAdd((a) => ({ ...a, label: e.target.value }))} />
            <label htmlFor="tm-add-groq" className="block text-[11px] text-dim mt-2 mb-1">Groq API key (optional)</label>
            <input
              id="tm-add-groq"
              className={inCls}
              type="password"
              value={add.groq}
              onChange={(e) => setAdd((a) => ({ ...a, groq: e.target.value }))}
            />
            {add.test && (
              <div
                className={
                  'mt-2 text-[11px] ' +
                  (add.test.startsWith('Key valid')
                    ? 'text-ok'
                    : add.test === 'Testing…' || add.test.startsWith('Unverified')
                      ? 'text-dim'
                      : 'text-crit')
                }
              >
                {add.test}
              </div>
            )}
            {add.err && <div className="mt-2 text-xs text-crit">{add.err}</div>}
            <div className="flex gap-2 mt-3">
              <button className="flex-1 px-2.5 py-1.5 rounded-lg bg-accent border border-accent text-white text-sm disabled:opacity-50" onClick={submitAdd} disabled={add.busy || !add.key}>
                {add.busy ? 'Adding…' : 'Add'}
              </button>
              <button className="px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt" onClick={testAddKey} disabled={!add.key}>Test</button>
              <button className="px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt" onClick={() => setAdd({ open: false, label: '', key: '', groq: '', err: '', busy: false, test: '' })}>Cancel</button>
            </div>
          </div>
        ) : edit ? (
          <div>
            <h3 className="text-xs font-semibold mb-2">Replace key for {edit.label || 'connection'}</h3>
            <label htmlFor="tm-edit-key" className="block text-[11px] text-dim mb-1">New Infoblox API key</label>
            <input
              id="tm-edit-key"
              className={inCls}
              type="password"
              value={edit.key}
              onChange={(e) => setEdit((s) => ({ ...s, key: e.target.value, test: '' }))}
              autoFocus
            />
            {edit.test && (
              <div
                className={
                  'mt-2 text-[11px] ' +
                  (edit.test.startsWith('Key valid')
                    ? 'text-ok'
                    : edit.test === 'Testing…' || edit.test.startsWith('Unverified')
                      ? 'text-dim'
                      : 'text-crit')
                }
              >
                {edit.test}
              </div>
            )}
            {edit.err && <div className="mt-2 text-xs text-crit">{edit.err}</div>}
            <div className="flex gap-2 mt-3">
              <button className="flex-1 px-2.5 py-1.5 rounded-lg bg-accent border border-accent text-white text-sm disabled:opacity-50" onClick={submitEdit} disabled={edit.busy || !edit.key}>
                {edit.busy ? 'Replacing…' : 'Replace key'}
              </button>
              <button className="px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt" onClick={testEditKey} disabled={!edit.key}>Test</button>
              <button className="px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="text-[10px] uppercase tracking-wide text-dim mb-2">Vault tenants</div>
            {statusError ? (
              <div className="mb-3">
                <FeedUnavailable label="Tenant status unavailable" reason="Could not read saved tenants — retry." />
              </div>
            ) : (
            <div className="space-y-1 mb-3">
              {tenants.map((t) => (
                <div key={t.id} className="flex items-center gap-1">
                  {confirmRm === t.id ? (
                    <div className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-crit/10 border border-crit/40">
                      <span className="flex-1 text-[11px] text-crit">Remove {t.label}?</span>
                      <button className="px-2 py-0.5 rounded border border-crit text-crit text-[11px]" aria-label="Confirm remove" title="Confirm remove" onClick={() => remove(t.id)}>✓</button>
                      <button className="px-2 py-0.5 rounded border border-border text-[11px] text-field-txt" aria-label="Cancel" title="Cancel" onClick={() => setConfirmRm(null)}>✕</button>
                    </div>
                  ) : (
                    <>
                      <button className={rowBtn} disabled={switchingAcct} onClick={() => setActive(t.id)}>
                        <span>{t.id === activeId ? '●' : '○'}</span>
                        <span className="truncate">{t.label}</span>
                      </button>
                      <button className={miniBtn} aria-label="Replace key" title="Replace key" onClick={() => openEdit(t)}>chg</button>
                      <button className={miniBtn + ' hover:text-crit hover:border-crit'} aria-label="Remove tenant" title="Remove" onClick={() => setConfirmRm(t.id)}>✕</button>
                    </>
                  )}
                </div>
              ))}
              {tenants.length === 0 && <div className="text-[11px] text-dim px-1">No tenants saved.</div>}
            </div>
            )}
            <button className="w-full px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt hover:border-border-hover mb-4" onClick={() => setAdd((a) => ({ ...a, open: true }))}>
              + Add connection
            </button>

            {/* Per-tenant write lock. Tenants are read-only until opted in, so
                this is the only place the dangerous routes can be turned on.
                See go/internal/vault/writelock.go. */}
            <div className="text-[10px] uppercase tracking-wide text-dim mb-2">Changing this tenant</div>
            {writeTargetError ? (
              <div className="mb-4">
                <FeedUnavailable label="Write permission unknown" reason={writeTargetError} />
              </div>
            ) : !writeTarget ? (
              <div className="text-[11px] text-dim px-1 mb-4">Checking…</div>
            ) : !writeTarget.known ? (
              <div className="mb-4">
                <FeedUnavailable
                  label="Cannot tell which tenant a change would hit"
                  reason={(writeTarget.reason || '') + ' — changes are refused until this resolves.'}
                />
              </div>
            ) : (
              <div className="mb-4 rounded-lg border border-border bg-field p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px]" style={{ color: writeTarget.writable ? 'var(--color-warn)' : 'var(--color-ok)' }}>
                    {writeTarget.writable ? '● Changes allowed' : '● Read-only'}
                  </span>
                  <span className="flex-1" />
                  <span className="text-[10px] text-dim font-mono truncate" title={writeTarget.tenant}>
                    {writeTarget.label || writeTarget.tenant}
                  </span>
                </div>
                <div className="text-[11px] text-dim mt-1.5">
                  {writeTarget.writable
                    ? 'Provisioning, teardown and record edits will really change this tenant.'
                    : 'Provisioning, teardown and record edits are refused. Nothing here can change this tenant.'}
                </div>
                {grantErr && <div className="mt-2 text-[11px] text-crit">{grantErr}</div>}
                {writeTarget.writable ? (
                  <button
                    className="w-full mt-2.5 px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt hover:border-border-hover disabled:opacity-50"
                    disabled={grantBusy}
                    onClick={() => setWritable(false)}
                  >
                    {grantBusy ? 'Saving…' : 'Make read-only'}
                  </button>
                ) : confirmGrant ? (
                  <div className="mt-2.5">
                    <div className="text-[11px] mb-2" style={{ color: 'var(--color-warn)' }}>
                      This lets teardown delete real DNS zones, subnets and address blocks in{' '}
                      {writeTarget.label || writeTarget.tenant}. Only do this on a tenant you own.
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="flex-1 px-2.5 py-1.5 rounded-lg border text-sm disabled:opacity-50"
                        style={{ borderColor: 'var(--color-crit)', color: 'var(--color-crit)' }}
                        disabled={grantBusy}
                        onClick={() => setWritable(true)}
                      >
                        {grantBusy ? 'Saving…' : 'Yes, allow changes'}
                      </button>
                      <button
                        className="px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt"
                        onClick={() => { setConfirmGrant(false); setGrantErr('') }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="w-full mt-2.5 px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt hover:border-border-hover"
                    onClick={() => setConfirmGrant(true)}
                  >
                    Allow changes to this tenant…
                  </button>
                )}
              </div>
            )}

            {accountsError ? (
              <div className="mb-4">
                <FeedUnavailable label="CSP accounts unavailable" reason={accountsError} />
              </div>
            ) : accounts.length > 0 && (
              <>
                <div className="text-[10px] uppercase tracking-wide text-dim mb-2">CSP account</div>
                <select
                  className={inCls + ' mb-4'}
                  defaultValue=""
                  onChange={(e) => e.target.value && switchCspAccount(e.target.value)}
                >
                  <option value="" disabled>Switch active account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </>
            )}

            {/* The header bar folds the theme switch away below `lg` (see
                App.jsx's A3 fold), so this is where it is reached on a narrow
                screen. Same component, so the two cannot drift; shown at every
                width because a settings sheet is where a reader looks for it
                anyway. */}
            {/* The caption under each switch is the SAME sentence the header's
                control-help dialog shows, read from the same dictionary, so the
                two can no more drift than the switches themselves can.
                It is written out rather than hidden behind a second ⓘ because
                this sheet is the only place a phone can read it at all — the
                header folds both switches, and the dialog with them.
                And it is what the row beside it never said: "Comfortable ·
                Compact" names the two settings, which is exactly what the
                pressed icon already showed. What it does was the missing part. */}
            <div className="text-[10px] uppercase tracking-wide text-dim mb-2">Appearance</div>
            <div className="mb-3">
              <div className="flex items-center gap-2">
                <ThemeSwitch />
                <span className="text-[11px] text-dim">Light · System · Dark</span>
              </div>
              <p className="m-0 mt-1 text-[11px] leading-relaxed text-dim">{CONTROL_HELP.theme.what}</p>
            </div>
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <DensitySwitch />
                <span className="text-[11px] text-dim">Comfortable · Compact</span>
              </div>
              <p className="m-0 mt-1 text-[11px] leading-relaxed text-dim">{CONTROL_HELP.density.what}</p>
            </div>

            {/* Same shape as Appearance above — section label, control, caption
                from the same dictionary the header dialog reads.
                The running version lives HERE and nowhere else in this sheet:
                it used to sit alone in the footer, and printing it twice inside
                one 420px panel would invite the reader to check whether the two
                agreed. `version` is the /api/vault/status reading, kept as the
                fallback for a server too old to answer the check endpoint at
                all — otherwise a failed check would take the version off screen
                with it. */}
            <UpdateCheck version={(status && status.version) || ''} />

            <label htmlFor="tm-dash-token" className="block text-[10px] uppercase tracking-wide text-dim mb-2">Dashboard token</label>
            <input
              id="tm-dash-token"
              className={inCls + ' mb-4'}
              type="password"
              value={dashToken}
              onChange={(e) => saveToken(e.target.value)}
              placeholder="X-Auth-Token for lock/admin actions"
            />

            <button className="w-full px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt hover:border-crit hover:text-crit disabled:opacity-50" onClick={lockNow} disabled={locking}>
              {locking ? 'Locking…' : 'Lock vault now'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
