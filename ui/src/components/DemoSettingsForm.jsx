import { useEffect, useState } from 'react'
import { COLORS, FIELD_CLS } from './ui.jsx'
import { authFetch } from '../lib/authFetch.js'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { API_KEY_BOX } from '../lib/secretBox.js'

// The demo server's settings: one form, used on the Demo server page and in
// the setup checklist. `st` is /api/demo/status; onSaved refreshes it.

const inputCls = `${FIELD_CLS} w-full`
const btnCls = 'px-3 py-2 rounded-control text-copy font-medium disabled:opacity-40 disabled:cursor-not-allowed'
const primary = { background: COLORS.accent, color: COLORS.onAccent }

const FIELDS = [
  ['pve', 'Proxmox SSH login', 'jsmith@10.0.0.2'],
  ['pveName', 'Proxmox host name (answered in the demo zone)', 'pve1'],
  ['pveIp', 'Proxmox host address', '10.0.0.2'],
  ['pool', 'Proxmox storage for the disk', 'local-zfs'],
  ['bridge', 'Demo bridge on Proxmox', 'vmbr9'],
  ['subnet', 'Demo network', '10.99.0.0/24'],
  ['gateway', 'Demo network gateway', '10.99.0.1'],
  ['image', 'NIOS-X image on this computer (.qcow2)', '/path/to/NIOS-X_OnPrem.qcow2'],
  ['owner', 'VM name prefix', 'jsmith'],
]

export default function DemoSettingsForm({ st, onSaved, onChange }) {
  const [form, setForm] = useState(null)
  const [token, setToken] = useState('')
  const [saveMsg, setSaveMsg] = useState(null)
  const [saving, setSaving] = useState(false)
  const problems = st?.problems || []

  useEffect(() => {
    if (st?.settings && form === null) setForm({ ...st.settings })
  }, [st, form])

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); onChange?.() }

  async function save() {
    setSaving(true); setSaveMsg(null)
    try {
      const r = await authFetch('/api/vault/demo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, joinToken: token }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.ok === false) setSaveMsg({ bad: true, text: j.error === 'locked' ? 'Unlock the vault first.' : (j.error || `HTTP ${r.status}`) })
      else {
        setToken('')
        setSaveMsg(j.problems?.length ? { bad: true, text: `Saved. Still to fix: ${j.problems.join('; ')}` } : { text: 'Saved.' })
        onSaved?.()
      }
    } catch (e) { setSaveMsg({ bad: true, text: String(e?.message || e) }) }
    setSaving(false)
  }

  return (
    <div className="flex flex-col gap-3">
      {FIELDS.map(([k, label, ph]) => (
        <label key={k} className="text-note text-muted flex flex-col gap-1">
          {label}
          <input className={inputCls} value={form?.[k] ?? ''} placeholder={ph} onChange={(e) => set(k, e.target.value)} {...MACHINE_TEXT} />
        </label>
      ))}
      <label className="text-note text-muted flex flex-col gap-1">
        NIOS-X join token
        <input type="password" className={inputCls} value={token} {...API_KEY_BOX}
          placeholder={st?.settings?.hasJoinToken ? 'Stored. Leave blank to keep it.' : 'Paste the join token from the Infoblox Portal'}
          onChange={(e) => setToken(e.target.value)} />
      </label>
      <div className="grid grid-cols-3 gap-2">
        {[['ram', 'RAM (MB)'], ['cores', 'Cores'], ['disk', 'Disk']].map(([k, label]) => (
          <label key={k} className="text-note text-muted flex flex-col gap-1">
            {label}
            <input className={inputCls} value={form?.[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...MACHINE_TEXT} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button className={btnCls} style={primary} disabled={saving || !form} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
        {saveMsg && <span className="text-note" style={{ color: saveMsg.bad ? COLORS.crit : COLORS.ok }} role="status">{saveMsg.text}</span>}
      </div>
      {problems.length > 0 && !saveMsg && (
        <ul className="text-note list-disc pl-5" style={{ color: COLORS.warn }}>
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  )
}
