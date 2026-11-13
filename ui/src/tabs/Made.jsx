// Made with Bloxsmith (owner, 2026-11-13): everything Bloxsmith made and
// deleted, with Delete on each item still there, and a finder to delete other
// items of the same kinds. Every delete asks once, and says whether Bloxsmith
// made the item. See go/internal/server/made.go.
import { useState } from 'react'
import { authFetch } from '../lib/authFetch.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { ReadOnlyNote } from '../components/kit.jsx'
import { Card, COLORS, FIELD_CLS, TabIntro } from '../components/ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import MadeList from '../components/MadeList.jsx'
import DeleteCheck from '../components/DeleteCheck.jsx'
import { KIND_WORDS, when } from '../lib/madeDelete.js'

const HINTS = {
  dns_record: 'part of the name, like printer',
  address: 'the full address, like 10.2.1.7',
  fixed_address: 'its name, or the full address',
  subnet: 'its name, or the network address like 10.2.1.0',
  dns_zone: 'part of the zone name',
  host: 'part of the host name',
  dhcp_range: 'its name, or the first address',
  custom_list: 'part of the list name',
  policy_rule: 'part of the policy or list name',
}

function FindOther({ ro }) {
  const [kind, setKind] = useState('dns_record')
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function find(e) {
    e.preventDefault()
    if (!q.trim()) return
    setBusy(true)
    setError(null)
    const r = await authFetch(`/api/made/find?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q.trim())}`)
    setBusy(false)
    if (!r.ok) { setFound(null); setError(r.data?.error || `HTTP ${r.status}`); return }
    setFound(r.data?.results ?? [])
  }

  return (
    <Card panelId="made-find" title="Delete something else" span={6}
      note="any item of these kinds, made with Bloxsmith or not; each delete asks first">
      <form role="search" aria-label="Find something to delete" onSubmit={find} className="flex flex-wrap items-end gap-2 px-3 pb-3">
        <label className="flex flex-col gap-1 text-note text-muted">
          What
          <select className={FIELD_CLS} value={kind} onChange={(e) => { setKind(e.target.value); setFound(null) }}>
            {Object.entries(KIND_WORDS).map(([k, w]) => <option key={k} value={k}>{w[0].toUpperCase() + w.slice(1)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-note text-muted flex-1 min-w-[12rem]">
          Name or address
          <input {...MACHINE_TEXT} className={FIELD_CLS} value={q} placeholder={HINTS[kind]}
            onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="submit" disabled={!q.trim() || busy} className="text-copy font-medium px-4 py-1.5 rounded-control"
          style={{ background: COLORS.accent, color: COLORS.onAccent }}>{busy ? 'Finding…' : 'Find'}</button>
      </form>
      {error && <p role="alert" className="text-note px-3" style={{ color: COLORS.crit }}>{error}</p>}
      {found && (found.length === 0
        ? <p className="text-note text-muted px-3">Nothing found. Up to 25 matches are shown.</p>
        : (
          <ul data-found="">
            {found.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 border-t border-border text-note">
                <span className="flex-1 min-w-[12rem] break-words">
                  {f.label}
                  <span className="block text-muted">{f.made_on ? `Made by Bloxsmith, ${when(f.made_on)}` : 'Not made by Bloxsmith'}</span>
                </span>
                <DeleteCheck kind={kind} id={f.id} what={f.label} ro={ro} onDone={() => setFound((xs) => xs.filter((x) => x.id !== f.id))} />
              </li>
            ))}
          </ul>
        ))}
    </Card>
  )
}

export default function Made() {
  const ro = useReadOnly()
  return (
    <div className="w-full px-6 py-5 flex flex-col gap-4">
      <div>
        <h1 className="text-copy font-semibold tracking-tight mb-1">Made with Bloxsmith</h1>
        <TabIntro>Everything Bloxsmith made and deleted, newest first. Items made with Bloxsmith carry the tag made_by=bloxsmith in Infoblox where it allows tags.</TabIntro>
      </div>
      <ReadOnlyNote ro={ro} what="Delete still shows what it would remove and whether Bloxsmith made it. The final Delete is off." />
      <Card panelId="made-all" title="What Bloxsmith made and deleted" span={6} note="from Automate, Get an address, Site lists and the Editor">
        <MadeList ro={ro.readOnly} empty="Nothing made with Bloxsmith yet." />
      </Card>
      <FindOther ro={ro.readOnly} />
    </div>
  )
}
