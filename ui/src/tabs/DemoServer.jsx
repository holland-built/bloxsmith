import { useEffect, useRef, useState } from 'react'
import { PageRail } from '../components/kit.jsx'
import { Card, CardGrid, COLORS, Empty, FetchError, FIELD_CLS, TabIntro } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'
import { authFetch, withToken } from '../lib/authFetch.js'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { API_KEY_BOX } from '../lib/secretBox.js'

// The Demo server page: build a NIOS-X VM on Proxmox with the next free IP,
// give it DNS, prove it answers, then tear down exactly what the run made.
// The server does the work (go/internal/demo); this page fills the settings,
// shows the plan first, and streams each step as it happens.

const inputCls = `${FIELD_CLS} w-full`
const btnCls = 'px-3 py-2 rounded-control text-copy font-medium disabled:opacity-40 disabled:cursor-not-allowed'
const primary = { background: COLORS.accent, color: COLORS.onAccent }
const danger = { background: COLORS.crit, color: COLORS.onCrit }

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

// stream opens one server-sent-event run and hands each frame to onFrame.
// It resolves with the last frame (done or error).
function stream(url, onFrame) {
  return new Promise((resolve) => {
    const es = new EventSource(withToken(url))
    let last = null
    es.onmessage = (e) => {
      let j = null
      try { j = JSON.parse(e.data) } catch { return }
      last = j
      onFrame(j)
      if (j.done || j.error) { es.close(); resolve(j) }
    }
    es.onerror = () => {
      es.close()
      resolve(last?.done || last?.error ? last : { error: 'The server closed the connection. The run record below shows how far it got.' })
    }
  })
}

function Mark({ state }) {
  const map = { ok: ['Done', COLORS.ok], fail: ['Failed', COLORS.crit], start: ['Running', COLORS.accent] }
  const [txt, col] = map[state] || ['Waiting', 'var(--color-muted, gray)']
  return <span className="text-note font-medium" style={{ color: col }}>{txt}</span>
}

export default function DemoServer() {
  const status = useApi('/api/demo/status')
  const st = status.data
  const [form, setForm] = useState(null)
  const [token, setToken] = useState('')
  const [saveMsg, setSaveMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState(null) // dry-run frame: checks, ready, code
  const [steps, setSteps] = useState({}) // step id -> state
  const [notes, setNotes] = useState([]) // {step, text, line}
  const [buildErr, setBuildErr] = useState(null)
  const [codeTab, setCodeTab] = useState('ip')

  const [removing, setRemoving] = useState(null) // {change, removes, phase}
  const logRef = useRef(null)

  useEffect(() => {
    if (st?.settings && form === null) setForm({ ...st.settings })
  }, [st, form])
  useEffect(() => { logRef.current?.scrollTo?.(0, logRef.current.scrollHeight) }, [notes])

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); setPlan(null) }

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
        status.refetch()
      }
    } catch (e) { setSaveMsg({ bad: true, text: String(e?.message || e) }) }
    setSaving(false)
  }

  function onEvent(ev) {
    if (!ev) return
    if (ev.state) setSteps((s) => ({ ...s, [ev.step]: ev.state }))
    if (ev.note || ev.line) setNotes((n) => [...n.slice(-400), { step: ev.step, text: ev.note, line: ev.line }])
    if (ev.code && ev.step) setCodeTab(ev.step === 'network' ? 'net' : ev.step)
  }

  async function preview() {
    setBusy(true); setPlan(null); setBuildErr(null)
    const end = await stream('/api/provision/demo/stream?dry=1', () => {})
    if (end.error) setBuildErr(end.error)
    else setPlan(end)
    setBusy(false)
  }

  async function build() {
    setBusy(true); setSteps({}); setNotes([]); setBuildErr(null)
    const end = await stream('/api/provision/demo/stream?dry=0', (j) => onEvent(j.event))
    if (end.error) setBuildErr(end.error)
    setPlan(null)
    status.refetch()
    setBusy(false)
  }

  async function removePreview(change) {
    setRemoving({ change, phase: 'checking' })
    const end = await stream(`/api/teardown/demo/stream?dry=1&change=${encodeURIComponent(change)}`, () => {})
    setRemoving(end.error ? { change, phase: 'error', error: end.error } : { change, phase: 'confirm', removes: end.removes || [] })
  }

  async function removeRun(change) {
    setRemoving({ change, phase: 'removing' })
    setNotes([]); setSteps({})
    const end = await stream(`/api/teardown/demo/stream?dry=0&change=${encodeURIComponent(change)}`, (j) => onEvent(j.event))
    setRemoving(end.error ? { change, phase: 'error', error: end.error } : null)
    status.refetch()
  }

  const code = plan?.code || {}
  const stepList = st?.steps || []
  const runs = st?.runs || []
  const problems = st?.problems || []

  return (
    <PageRail>
      <div className="w-full px-6 py-5">
        <h1 className="text-copy font-semibold tracking-tight mb-1">Demo server</h1>
        <TabIntro anchor="demo-server">
          Builds a NIOS-X server on Proxmox with the next free address from Infoblox, gives it DNS, and proves it
          answers. The Infoblox parts run as {st?.terraform || 'OpenTofu'} code you can read below. Every run gets its
          own ID, and Tear down removes only what that run made.
        </TabIntro>

        <CardGrid layoutKey="demo">
          <Card panelId="demo-settings" span={3} title="Settings" note="saved in the vault; the join token is never shown again">
            {status.loading && !form ? <Empty>Loading…</Empty> : (
              <div className="flex flex-col gap-3">
                <FetchError error={status.error} stale={!!st} />
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
            )}
          </Card>

          <Card panelId="demo-build" span={3} title="Build" note="preview first; nothing is created until you press Build">
            <div className="flex flex-col gap-3">
              <div className="flex gap-2 flex-wrap">
                <button className={btnCls} style={primary} disabled={busy || problems.length > 0} onClick={preview}>
                  {busy && !plan ? 'Checking…' : 'Preview'}
                </button>
                {plan?.ready && (
                  <button className={btnCls} style={primary} disabled={busy} onClick={build}>{busy ? 'Building…' : 'Build it'}</button>
                )}
              </div>
              {problems.length > 0 && <div className="text-note text-muted">Fill in the settings first.</div>}
              {plan && (
                <ul className="flex flex-col gap-1.5">
                  {plan.checks.map((c) => (
                    <li key={c.says} className="text-copy">
                      <span style={{ color: c.ok ? COLORS.ok : COLORS.crit }}>{c.ok ? 'Ready' : 'Not ready'}</span>
                      {' '}{c.says}
                      {!c.ok && c.fix && <div className="text-note text-muted pl-4">{c.fix}</div>}
                    </li>
                  ))}
                </ul>
              )}
              <ol className="flex flex-col gap-2 list-decimal pl-5">
                {stepList.map((s) => (
                  <li key={s.ID} className="text-copy">
                    <div className="flex items-baseline gap-2 flex-wrap"><span>{s.Says}</span><Mark state={steps[s.ID]} /></div>
                  </li>
                ))}
              </ol>
              {buildErr && <div className="text-copy" role="alert" style={{ color: COLORS.crit }}>{buildErr}</div>}
              {notes.length > 0 && (
                <div ref={logRef} className="font-mono text-note max-h-64 overflow-auto rounded-control p-2" style={{ background: 'var(--color-surface-2, rgba(127,127,127,.08))' }} aria-live="polite">
                  {notes.map((n, i) => (
                    <div key={i} className={n.text ? '' : 'text-muted'}>{n.text ? `${n.step}: ${n.text}` : n.line}</div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card panelId="demo-code" span={6} title="The Infoblox code" note={`what ${st?.terraform || 'OpenTofu'} runs for each step`}>
            {!plan ? <Empty>Press Preview to see the code each step runs.</Empty> : (
              <div className="flex flex-col gap-2">
                <div className="flex gap-1 flex-wrap" role="tablist">
                  {[['net', 'Network'], ['ip', 'Next free IP'], ['dns', 'DNS']].map(([k, label]) => (
                    <button key={k} role="tab" aria-selected={codeTab === k} onClick={() => setCodeTab(k)}
                      className="px-3 py-1.5 text-note font-medium border-b-2"
                      style={{ borderColor: codeTab === k ? COLORS.accent : 'transparent' }}>{label}</button>
                  ))}
                </div>
                {Object.entries(code[codeTab] || {}).map(([name, src]) => (
                  <div key={name}>
                    <div className="text-note text-muted mb-1">{name}</div>
                    <pre className="font-mono text-note overflow-x-auto p-3 rounded-control" style={{ background: 'var(--color-surface-2, rgba(127,127,127,.08))' }}>{src}</pre>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card panelId="demo-runs" span={6} title="Runs" note="each run is tagged with its ID in Infoblox and on the VM">
            {runs.length === 0 ? <Empty>No demo runs yet.</Empty> : (
              <div className="overflow-x-auto">
                <table className="w-full text-copy">
                  <thead>
                    <tr className="text-left text-note text-muted">
                      <th className="py-1 pr-3 font-medium">Run</th><th className="py-1 pr-3 font-medium">State</th>
                      <th className="py-1 pr-3 font-medium">Address</th><th className="py-1 pr-3 font-medium">Zone</th>
                      <th className="py-1 pr-3 font-medium">VM</th><th className="py-1 font-medium"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.change} className="align-top border-t" style={{ borderColor: 'var(--color-border, rgba(127,127,127,.2))' }}>
                        <td className="py-2 pr-3 font-mono text-note">{r.change}</td>
                        <td className="py-2 pr-3">{r.status}{r.error && <div className="text-note" style={{ color: COLORS.crit }}>{r.error}</div>}
                          {r.proof?.length > 0 && <div className="text-note text-muted">{r.proof.join(' · ')}</div>}</td>
                        <td className="py-2 pr-3 font-mono text-note">{r.ip || '—'}</td>
                        <td className="py-2 pr-3 font-mono text-note">{r.zone || '—'}</td>
                        <td className="py-2 pr-3 text-note">{r.vmid ? `${r.vmid} ${r.vmName || ''}` : '—'}</td>
                        <td className="py-2">
                          {r.status !== 'removed' && removing?.change !== r.change && (
                            <button className={btnCls} style={{ color: COLORS.crit }} disabled={busy || !!removing} onClick={() => removePreview(r.change)}>Tear down</button>
                          )}
                          {removing?.change === r.change && removing.phase === 'confirm' && (
                            <div className="flex flex-col gap-2">
                              <div className="text-note">This removes:</div>
                              <ul className="text-note list-disc pl-5">{removing.removes.map((x) => <li key={x}>{x}</li>)}</ul>
                              <div className="flex gap-2">
                                <button className={btnCls} style={danger} onClick={() => removeRun(r.change)}>Remove these</button>
                                <button className={btnCls} onClick={() => setRemoving(null)}>Keep</button>
                              </div>
                            </div>
                          )}
                          {removing?.change === r.change && (removing.phase === 'checking' || removing.phase === 'removing') && (
                            <span className="text-note text-muted">{removing.phase === 'checking' ? 'Checking…' : 'Removing…'}</span>
                          )}
                          {removing?.change === r.change && removing.phase === 'error' && (
                            <div className="text-note" role="alert" style={{ color: COLORS.crit }}>{removing.error}
                              <button className="underline ml-2" onClick={() => setRemoving(null)}>Close</button></div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </CardGrid>
      </div>
    </PageRail>
  )
}
