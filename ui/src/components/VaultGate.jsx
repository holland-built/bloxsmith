import { useCallback, useEffect, useState } from 'react'

// vpost — POST JSON, always resolves {ok,data}.
const vpost = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
    .catch(() => ({ ok: false, data: { error: 'network error' } }))

const inCls =
  'w-full px-2.5 py-1.5 rounded-lg border border-[#2a2a2a] bg-[#141414] text-[#ddd] text-sm outline-none focus:border-accent'
const btnCls =
  'w-full mt-4 px-2.5 py-1.5 rounded-lg bg-accent border border-accent text-white text-sm font-medium disabled:opacity-50'
const cancelCls =
  'w-full mt-2 px-2.5 py-1.5 rounded-lg border border-[#2a2a2a] text-[#ddd] text-sm bg-transparent disabled:opacity-50'

function Screen({ children }) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-bg px-6">
      <div className="w-[360px] max-w-full bg-card border border-card-border rounded-card p-8">{children}</div>
    </div>
  )
}

function Setup({ onDone }) {
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setErr('')
    if (p1.length < 8) return setErr('Passphrase must be at least 8 characters.')
    if (p1 !== p2) return setErr('Passphrases do not match.')
    setBusy(true)
    const { ok, data } = await vpost('/api/vault/init', { passphrase: p1 })
    setBusy(false)
    if (ok && data.ok) onDone()
    else setErr(data.error || 'Setup failed.')
  }

  return (
    <Screen>
      <div className="text-sm font-semibold mb-5">◆ Bloxsmith</div>
      <h1 className="text-base font-semibold mb-2">Create your vault</h1>
      <p className="text-xs leading-relaxed text-muted mb-4">
        Set a passphrase to encrypt your Infoblox tenant keys at rest. It is never stored — you re-enter it after a
        restart to unlock. There is no recovery if you forget it.
      </p>
      <label className="block text-[11px] text-dim mb-1" htmlFor="vs-pass">Passphrase</label>
      <input id="vs-pass" className={inCls} type="password" value={p1} onChange={(e) => setP1(e.target.value)} autoFocus />
      <label className="block text-[11px] text-dim mt-3 mb-1" htmlFor="vs-confirm">Confirm passphrase</label>
      <input
        id="vs-confirm"
        className={inCls}
        type="password"
        value={p2}
        onChange={(e) => setP2(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
      />
      {err && <div className="mt-2 text-xs text-crit">{err}</div>}
      <button className={btnCls} onClick={go} disabled={busy || !p1 || !p2}>
        {busy ? 'Creating…' : 'Create vault'}
      </button>
    </Screen>
  )
}

function Unlock({ onDone }) {
  const [p, setP] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const go = async () => {
    if (!p) return
    setErr('')
    setBusy(true)
    const { ok, data } = await vpost('/api/vault/unlock', { passphrase: p })
    setBusy(false)
    if (ok && data.ok) onDone()
    else setErr(data.error || 'Unlock failed.')
  }

  return (
    <Screen>
      <div className="text-sm font-semibold mb-5">◆ Bloxsmith</div>
      <h1 className="text-base font-semibold mb-2">Unlock vault</h1>
      <p className="text-xs leading-relaxed text-muted mb-4">Enter your passphrase to decrypt your saved tenant keys.</p>
      <label className="block text-[11px] text-dim mb-1" htmlFor="vu-pass">Passphrase</label>
      <input
        id="vu-pass"
        className={inCls}
        type="password"
        value={p}
        onChange={(e) => setP(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        autoFocus
      />
      {err && <div className="mt-2 text-xs text-crit">{err}</div>}
      <button className={btnCls} onClick={go} disabled={busy || !p}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      <div className="text-center mt-3.5">
        <button
          className="bg-transparent border-none text-dim text-[11px] underline underline-offset-2"
          onClick={() => setConfirmReset(true)}
        >
          Forgot passphrase? Reset vault
        </button>
      </div>
      {confirmReset && (
        <div className="mt-3 p-2.5 border border-crit/40 rounded-lg bg-crit/10" role="dialog" aria-label="Confirm vault reset">
          <div className="text-xs font-semibold mb-1">Reset vault?</div>
          <div className="text-[11px] text-muted leading-relaxed mb-2">
            Permanently deletes the vault and all stored keys. No recovery. You will set a new passphrase.
          </div>
          <div className="flex gap-2">
            <button
              className="px-2.5 py-1 rounded-lg border border-crit text-crit text-xs"
              onClick={async () => {
                setConfirmReset(false)
                await vpost('/api/vault/reset', {})
                onDone()
              }}
            >
              Reset vault
            </button>
            <button className="px-2.5 py-1 rounded-lg border border-[#2a2a2a] text-[#ddd] text-xs" autoFocus onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Screen>
  )
}

function FirstTenant({ onDone }) {
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [groq, setGroq] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState('')

  const go = async () => {
    if (!key) return
    setErr('')
    setBusy(true)
    const { ok, data } = await vpost('/api/vault/tenant', { label, key, groqKey: groq || undefined })
    setBusy(false)
    if (ok && data.ok) onDone()
    else setErr(data.error || 'Could not add connection.')
  }

  const doTest = async () => {
    if (!key) return
    setTest('Testing…')
    const { ok, data } = await vpost('/api/vault/test-key', { key })
    setTest(ok && data.ok ? 'Key valid' + (data.name ? ' — ' + data.name : ' (no account name)') : 'Invalid: ' + (data.error || 'rejected'))
  }

  return (
    <Screen>
      <div className="text-sm font-semibold mb-5">◆ Bloxsmith</div>
      <h1 className="text-base font-semibold mb-2">Add your first connection</h1>
      <p className="text-xs leading-relaxed text-muted mb-4">
        Paste an Infoblox API key. The key is encrypted in your vault, and the connection is named automatically from
        its CSP account.
      </p>
      <label className="block text-[11px] text-dim mb-1" htmlFor="vat-key">Infoblox API key</label>
      <input
        id="vat-key"
        className={inCls}
        type="password"
        value={key}
        onChange={(e) => { setKey(e.target.value); setTest('') }}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        placeholder="paste token (any format — Token/Bearer prefix optional)"
        autoFocus
      />
      <label className="block text-[11px] text-dim mt-3 mb-1" htmlFor="vat-name">Name (optional)</label>
      <input
        id="vat-name"
        className={inCls}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        placeholder="leave blank to use the CSP account name"
      />
      <label className="block text-[11px] text-dim mt-3 mb-1" htmlFor="vat-groq">Groq API key (optional — for AI query box)</label>
      <input
        id="vat-groq"
        className={inCls}
        type="password"
        value={groq}
        onChange={(e) => setGroq(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        placeholder="gsk_… (can add later)"
      />
      {test && (
        <div className={'mt-2 text-[11px] ' + (test.startsWith('Key valid') ? 'text-ok' : test === 'Testing…' ? 'text-dim' : 'text-crit')}>
          {test}
        </div>
      )}
      {err && <div className="mt-2 text-xs text-crit">{err}</div>}
      <button className={btnCls} onClick={go} disabled={busy || !key}>
        {busy ? 'Adding…' : 'Add connection'}
      </button>
      <button className={cancelCls} onClick={doTest} disabled={!key}>Test key</button>
    </Screen>
  )
}

export default function VaultGate({ children }) {
  const [st, setSt] = useState(null)

  const refresh = useCallback(() => {
    fetch('/api/vault/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setSt)
      .catch(() => setSt({ vaultMode: false }))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const on = () => refresh()
    window.addEventListener('bx:vault-locked', on)
    return () => window.removeEventListener('bx:vault-locked', on)
  }, [refresh])

  if (!st) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-bg">
        <div className="w-7 h-7 rounded-full border-2 border-[#2a2a2a] border-t-accent animate-spin" />
        <div className="text-sm font-semibold">◆ Bloxsmith</div>
      </div>
    )
  }

  if (!st.vaultMode || st.ready) return children
  if (!st.exists) return <Setup onDone={refresh} />
  if (!st.unlocked) return <Unlock onDone={refresh} />
  return <FirstTenant onDone={refresh} />
}
