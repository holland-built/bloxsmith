import { useEffect, useState } from 'react'
import { COLORS, FIELD_CLS } from './ui.jsx'
import { tokenFetch } from '../lib/authFetch.js'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { API_KEY_BOX } from '../lib/secretBox.js'
import { WRITE_UNKNOWN, writeFailureText } from '../lib/writeFailure.js'

// The demo server's settings: one form, used on the Demo server page and in
// the setup checklist. `st` is /api/demo/status; onSaved refreshes it.

const inputCls = `${FIELD_CLS} w-full`
const btnCls = 'px-3 py-2 rounded-control text-copy font-medium disabled:opacity-40 disabled:cursor-not-allowed'
const primary = { background: COLORS.accent, color: COLORS.onAccent }

// Plain labels (GUI audit E8); the technical value the person types stays
// visible as the "e.g." hint (E10).
const FIELDS = [
  ['pve', 'Proxmox login (user@address)', 'e.g. jsmith@10.0.0.2'],
  ['pveName', 'Proxmox computer name (answered in the demo zone)', 'e.g. pve1'],
  ['pveIp', 'Proxmox computer address', 'e.g. 10.0.0.2'],
  ['pool', 'Proxmox storage for the disk', 'e.g. local-zfs'],
  ['bridge', 'Proxmox network the demo server joins', 'e.g. vmbr9'],
  ['subnet', 'Demo network', 'e.g. 10.99.0.0/24'],
  ['gateway', 'Demo network gateway', 'e.g. 10.99.0.1'],
  ['image', 'Infoblox server image file on this computer', 'e.g. /path/to/NIOS-X_OnPrem.qcow2'],
  ['owner', 'Start of each demo server name', 'e.g. jsmith'],
]

// The server stores the disk size as "64G"; the box asks for a number of GB.
const SIZES = [
  ['ram', 'RAM (MB)', 'e.g. 4096'],
  ['cores', 'Cores', 'e.g. 3'],
  ['disk', 'Disk (GB)', 'e.g. 64'],
]
const shownSize = (k, v) => (k === 'disk' ? String(v ?? '').replace(/G$/i, '') : (v ?? ''))
const savedDisk = (v) => (/^\s*\d+\s*$/.test(String(v ?? '')) ? `${String(v).trim()}G` : v)

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
      const r = await tokenFetch('/api/vault/demo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, disk: savedDisk(form.disk), joinToken: token }),
      })
      const data = await r.json().catch(() => null)
      const j = data ?? {}
      if (!r.ok || !data || j.ok === false) setSaveMsg({ bad: true, text: j.error === 'locked' ? 'Unlock the vault first.' : writeFailureText(r.status, data, 'save the demo settings') })
      else {
        setToken('')
        setSaveMsg(j.problems?.length ? { bad: true, text: `Saved. Still to fix: ${j.problems.join('; ')}` } : { text: 'Saved.' })
        onSaved?.()
      }
    } catch { setSaveMsg({ bad: true, text: WRITE_UNKNOWN }) }
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
        Server sign-up code from the Infoblox Portal
        <input type="password" className={inputCls} value={token} {...API_KEY_BOX}
          placeholder={st?.settings?.hasJoinToken ? 'Stored. Leave blank to keep it.' : 'Paste the code the Portal calls a “join token”'}
          onChange={(e) => setToken(e.target.value)} />
      </label>
      <div className="grid grid-cols-3 gap-2">
        {SIZES.map(([k, label, ph]) => (
          <label key={k} className="text-note text-muted flex flex-col gap-1">
            {label}
            <input className={inputCls} value={shownSize(k, form?.[k])} placeholder={ph} onChange={(e) => set(k, e.target.value)} {...MACHINE_TEXT} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button className={btnCls} style={primary} disabled={saving || !form} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
        {saveMsg && <span className="text-note" style={{ color: saveMsg.bad ? COLORS.crit : COLORS.ok }} role="status">{saveMsg.text}</span>}
      </div>
      {problems.length > 0 && !saveMsg && (
        <ul className="text-note text-muted list-disc pl-5">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  )
}
