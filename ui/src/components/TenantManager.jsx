import { useEffect, useState } from 'react'

const vpost = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
    .catch(() => ({ ok: false, data: { error: 'network error' } }))

const inCls =
  'w-full px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none focus:border-accent'
const rowBtn = 'flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-sm text-field-txt hover:bg-line'
const miniBtn = 'px-2 py-1 rounded-lg border border-border text-[11px] text-muted hover:text-txt hover:border-border-hover'

export default function TenantManager({ onClose }) {
  const [status, setStatus] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [dashToken, setDashToken] = useState(() => localStorage.getItem('dashToken') || '')
  const [confirmRm, setConfirmRm] = useState(null)
  const [locking, setLocking] = useState(false)
  const [switchingAcct, setSwitchingAcct] = useState(false)

  const [add, setAdd] = useState({ open: false, label: '', key: '', groq: '', err: '', busy: false, test: '' })
  const [edit, setEdit] = useState(null) // { id, label, key, err, busy, test }

  const authHeaders = () => {
    const t = localStorage.getItem('dashToken')
    return t ? { 'X-Auth-Token': t } : {}
  }

  const load = () => {
    fetch('/api/vault/status', { cache: 'no-store' }).then((r) => r.json()).then(setStatus).catch(() => {})
    fetch('/api/accounts', { cache: 'no-store' }).then((r) => r.json()).then((d) => setAccounts(d.accounts || [])).catch(() => {})
  }

  useEffect(() => { load() }, [])

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
    setAdd((a) => ({ ...a, test: ok && data.ok ? 'Key valid' + (data.name ? ' — ' + data.name : '') : 'Invalid: ' + (data.error || 'rejected') }))
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
    setEdit((e) => ({ ...e, test: ok && data.ok ? 'Key valid' + (data.name ? ' — ' + data.name : '') : 'Invalid: ' + (data.error || 'rejected') }))
  }

  const lockNow = async () => {
    setLocking(true)
    await fetch('/api/vault/lock', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: '{}' })
    setLocking(false)
    window.dispatchEvent(new Event('bx:vault-locked'))
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="w-[420px] max-w-full max-h-[80vh] overflow-y-auto bg-card border border-card-border rounded-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-4">
          <h2 className="text-sm font-semibold">Settings</h2>
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
              <div className={'mt-2 text-[11px] ' + (add.test.startsWith('Key valid') ? 'text-ok' : add.test === 'Testing…' ? 'text-dim' : 'text-crit')}>
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
              <div className={'mt-2 text-[11px] ' + (edit.test.startsWith('Key valid') ? 'text-ok' : edit.test === 'Testing…' ? 'text-dim' : 'text-crit')}>
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
            <button className="w-full px-2.5 py-1.5 rounded-lg border border-border text-sm text-field-txt hover:border-border-hover mb-4" onClick={() => setAdd((a) => ({ ...a, open: true }))}>
              + Add connection
            </button>

            {accounts.length > 0 && (
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

            <div className="mt-4 pt-3 border-t border-line-2 text-[11px] text-dim text-center">
              Bloxsmith {(status && status.version) || '…'}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
