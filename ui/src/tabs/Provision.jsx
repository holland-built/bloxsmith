import { useEffect, useRef, useState } from 'react'
import { COLORS, Card, Empty, Skeleton } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'

const inputCls = 'px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none w-full'
const btnBase = 'px-3.5 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed'
const btnPrimary = `${btnBase} bg-accent text-white`
const btnOutline = `${btnBase} border border-border bg-transparent text-field-txt`

export default function Provision() {
  const [mode, setMode] = useState('subnet') // 'subnet' | 'site' | 'seed'
  const whoami = useApi('/api/whoami')
  const role = whoami.data?.role || 'viewer'
  const isAdmin = role === 'admin'

  return (
    <div className="max-w-[720px] mx-auto p-5">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-semibold tracking-tight">Provision</h1>
        <span
          className="text-[11px] font-medium px-2 py-0.5 rounded-full"
          style={{
            background: isAdmin ? 'var(--pill-ok-bg)' : role === 'operator' ? 'var(--pill-warn-bg)' : 'var(--pill-crit-bg)',
            color: isAdmin ? 'var(--pill-ok-fg)' : role === 'operator' ? 'var(--pill-warn-fg)' : 'var(--pill-crit-fg)',
          }}
        >
          {role.toUpperCase()}
        </span>
      </div>

      <div className="flex gap-1 mb-4 p-1 rounded-lg bg-field border border-border w-fit">
        {[
          ['subnet', 'Subnet'],
          ['site', 'Full site'],
          ['seed', 'Seed demo'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium ${
              mode === key ? 'bg-accent text-white' : 'text-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'subnet' ? <SubnetMode /> : mode === 'site' ? <SiteMode isAdmin={isAdmin} /> : <SeedMode isAdmin={isAdmin} />}
    </div>
  )
}

// ---------- log rendering ----------

function LogView({ log, doneLabel }) {
  if (log.length === 0) return <Empty>Output appears here when you run a provision.</Empty>
  return (
    <div className="font-mono text-[12px] flex flex-col gap-0.5 max-h-[280px] overflow-auto">
      {log.map((l, i) => (
        <div key={i} style={{ color: l.error ? 'var(--color-crit)' : l.done ? 'var(--color-ok)' : 'var(--color-muted)' }}>
          {l.error ? `✕ ${l.error}` : l.done ? `✓ ${doneLabel || 'done'}` : l.step || JSON.stringify(l)}
        </div>
      ))}
    </div>
  )
}

// ---------- subnet mode ----------

function SubnetMode() {
  const spacesApi = useApi('/api/ipam/spaces')
  const spaces = spacesApi.data?.spaces ?? []
  const [space, setSpace] = useState('')
  const blocksApi = useApi(space ? `/api/ipam/blocks?space=${encodeURIComponent(space)}` : null)
  const blocks = blocksApi.data?.blocks ?? []
  const [block, setBlock] = useState('')
  const [cidr, setCidr] = useState(24)
  const [name, setName] = useState('')
  const [comment, setComment] = useState('')
  const [makeZone, setMakeZone] = useState(false)
  const [dry, setDry] = useState(true)

  const [log, setLog] = useState([])
  const [streaming, setStreaming] = useState(false)
  const [success, setSuccess] = useState(null)
  const [err, setErr] = useState(null)
  const esRef = useRef(null)

  useEffect(() => () => esRef.current?.close(), [])

  function start() {
    if (streaming || esRef.current) return
    setLog([]); setSuccess(null); setErr(null); setStreaming(true)
    const qs = new URLSearchParams({
      space, block, cidr: String(cidr || 24), name, comment,
      make_zone: makeZone ? '1' : '0', dry: dry ? '1' : '0',
    })
    const es = new EventSource('/api/provision/stream?' + qs.toString())
    esRef.current = es
    const stop = () => { esRef.current?.close(); esRef.current = null; setStreaming(false) }
    es.onmessage = (e) => {
      let j = null
      try { j = JSON.parse(e.data) } catch { return }
      setLog((prev) => [...prev, j])
      if (j?.error) { setErr(j.error); stop() }
      else if (j?.done) { setSuccess(j.subnet || null); stop() }
    }
    es.onerror = () => { if (!esRef.current) return; setErr((p) => p || 'Stream connection error'); stop() }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card title="Request" span={6}>
        <div className="flex flex-col gap-3">
          <Field label="Space">
            <select className={inputCls} value={space} onChange={(e) => { setSpace(e.target.value); setBlock('') }}>
              <option value="">{spacesApi.loading ? 'Loading spaces…' : 'Select a space'}</option>
              {spaces.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
            </select>
          </Field>
          <Field label="Block">
            <select className={inputCls} value={block} onChange={(e) => setBlock(e.target.value)} disabled={!space}>
              <option value="">{blocksApi.loading ? 'Loading blocks…' : 'Select a block'}</option>
              {blocks.map((b) => <option key={b.id} value={b.id}>{b.name || b.cidr || b.address}</option>)}
            </select>
          </Field>
          <Field label="CIDR prefix">
            <input type="number" min="1" max="32" className={inputCls} value={cidr} onChange={(e) => setCidr(e.target.value)} />
          </Field>
          <Field label="Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="subnet name" />
          </Field>
          <Field label="Comment">
            <input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="optional" />
          </Field>
          <CheckRow checked={makeZone} onChange={setMakeZone} label="Create matching DNS zone" />
          <CheckRow checked={dry} onChange={setDry} label="Dry-run (no changes made)" />
          <div className="flex items-center gap-2 pt-1">
            <button className={btnOutline} disabled={streaming || !space} onClick={() => { setDry(true); start() }}>Dry-run</button>
            <button className={btnPrimary} disabled={streaming || !space} onClick={start}>
              {streaming ? 'Provisioning…' : dry ? 'Run dry-run' : 'Provision'}
            </button>
          </div>
        </div>
      </Card>

      <Card title="Live log" span={6}>
        <LogView log={log} doneLabel={success ? `done — subnet ${success.address || success.id || ''}` : 'done'} />
      </Card>

      {success && (
        <Card title="Success" span={6}>
          <div className="font-mono text-[12px]">
            Subnet id: {success.id ?? '—'} · {success.address || ''}{success.cidr ? `/${success.cidr}` : ''}
          </div>
        </Card>
      )}
      {err && (
        <Card title="Error" span={6}>
          <div className="font-mono text-[12px]" style={{ color: COLORS.crit }}>{err}</div>
        </Card>
      )}
    </div>
  )
}

// ---------- site mode ----------

function SiteMode({ isAdmin }) {
  const spacesApi = useApi('/api/ipam/spaces')
  const spaces = spacesApi.data?.spaces ?? []
  const templatesApi = useApi('/api/templates')
  const templates = Array.isArray(templatesApi.data) ? templatesApi.data : []

  const [siteSpace, setSiteSpace] = useState('')
  const [siteTemplate, setSiteTemplate] = useState('')
  const [siteDry, setSiteDry] = useState(true)
  const [siteLog, setSiteLog] = useState([])
  const [siteStreaming, setSiteStreaming] = useState(false)
  const [siteSuccess, setSiteSuccess] = useState(null)
  const [siteErr, setSiteErr] = useState(null)
  const siteEsRef = useRef(null)

  const [tdDry, setTdDry] = useState(true)
  const [tdConfirm, setTdConfirm] = useState('')
  const [tdLog, setTdLog] = useState([])
  const [tdStreaming, setTdStreaming] = useState(false)
  const [tdResult, setTdResult] = useState(null)
  const [tdErr, setTdErr] = useState(null)
  const tdEsRef = useRef(null)

  useEffect(() => () => { siteEsRef.current?.close(); tdEsRef.current?.close() }, [])

  function siteStart() {
    if (siteStreaming || siteEsRef.current) return
    setSiteLog([]); setSiteSuccess(null); setSiteErr(null); setSiteStreaming(true)
    const qs = new URLSearchParams({ template: siteTemplate, dry: siteDry ? '1' : '0' })
    if (siteSpace) qs.set('ip_space', siteSpace)
    const es = new EventSource('/api/provision/site/stream?' + qs.toString())
    siteEsRef.current = es
    const stop = () => { siteEsRef.current?.close(); siteEsRef.current = null; setSiteStreaming(false) }
    es.onmessage = (e) => {
      let j = null
      try { j = JSON.parse(e.data) } catch { return }
      setSiteLog((prev) => [...prev, j])
      if (j?.error) { setSiteErr(j.error); stop() }
      else if (j?.done) { setSiteSuccess(j.result || null); stop() }
    }
    es.onerror = () => { if (!siteEsRef.current) return; setSiteErr((p) => p || 'Stream connection error'); stop() }
  }

  function teardownStart() {
    if (tdStreaming || tdEsRef.current) return
    if (!tdDry && !isAdmin) return
    if (!tdDry && !tdConfirm.trim()) return
    setTdLog([]); setTdResult(null); setTdErr(null); setTdStreaming(true)
    const qs = new URLSearchParams({ template: siteTemplate, dry: tdDry ? '1' : '0' })
    if (siteSpace) qs.set('ip_space', siteSpace)
    if (!tdDry) qs.set('confirm', tdConfirm.trim())
    const es = new EventSource('/api/teardown/site/stream?' + qs.toString())
    tdEsRef.current = es
    const stop = () => { tdEsRef.current?.close(); tdEsRef.current = null; setTdStreaming(false) }
    es.onmessage = (e) => {
      let j = null
      try { j = JSON.parse(e.data) } catch { return }
      setTdLog((prev) => [...prev, j])
      if (j?.error) { setTdErr(j.error); stop() }
      else if (j?.done) { setTdResult(j.result || null); stop() }
    }
    es.onerror = () => { if (!tdEsRef.current) return; setTdErr((p) => p || 'Stream connection error'); stop() }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card title="Request" span={6}>
        <div className="flex flex-col gap-3">
          <Field label="IP space (override)">
            <select className={inputCls} value={siteSpace} onChange={(e) => setSiteSpace(e.target.value)}>
              <option value="">— template default —</option>
              {spaces.map((sp) => <option key={sp.id} value={sp.name}>{sp.name}</option>)}
            </select>
          </Field>
          <Field label="Template">
            <select className={inputCls} value={siteTemplate} onChange={(e) => setSiteTemplate(e.target.value)}>
              <option value="">{templatesApi.loading ? 'Loading templates…' : 'Select a template'}</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} — {t.region || ''}/{t.environment || ''}{t.valid === false ? ' (invalid)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <CheckRow checked={siteDry} onChange={setSiteDry} label="Dry-run (no changes made)" />
          <div className="flex items-center gap-2 pt-1">
            <button className={btnOutline} disabled={siteStreaming || !siteTemplate} onClick={() => { setSiteDry(true); siteStart() }}>Dry-run</button>
            <button className={btnPrimary} disabled={siteStreaming || !siteTemplate} onClick={siteStart}>
              {siteStreaming ? 'Provisioning…' : siteDry ? 'Run dry-run' : 'Provision site'}
            </button>
          </div>
        </div>
      </Card>

      <Card title="Live log" span={6}>
        <LogView log={siteLog} />
      </Card>

      {siteSuccess && (
        <Card title="Success" span={6}>
          {siteSuccess.skipped ? (
            <div className="font-mono text-[12px] text-muted">Skipped — {siteSuccess.skip_reason || 'already provisioned'}.</div>
          ) : (
            <div className="font-mono text-[12px] flex flex-col gap-0.5">
              <div><span className="text-muted">Block: </span>{siteSuccess.block_address || '—'}</div>
              <div><span className="text-muted">DNS zone: </span>{siteSuccess.dns_zone_fqdn || '—'}</div>
              <div>
                <span className="text-muted">Subnets: </span>{(siteSuccess.subnets || []).length} ·{' '}
                <span className="text-muted">DHCP ranges: </span>{(siteSuccess.dhcp_ranges || []).length} ·{' '}
                <span className="text-muted">Hosts: </span>{(siteSuccess.hosts || []).length}
              </div>
              {siteSuccess.dry_run && <div style={{ color: COLORS.warn }}>Dry-run — nothing was created.</div>}
            </div>
          )}
        </Card>
      )}
      {siteErr && (
        <Card title="Error" span={6}>
          <div className="font-mono text-[12px]" style={{ color: COLORS.crit }}>{siteErr}</div>
        </Card>
      )}

      <Card title="Tear down this site" note="permanently deletes its provisioned objects" span={6}>
        <div className="flex flex-col gap-3">
          <CheckRow checked={tdDry} onChange={setTdDry} label="Dry-run (no changes made)" />
          {!tdDry && (
            isAdmin ? (
              <Field label="Type the site name to confirm">
                <input className={inputCls} value={tdConfirm} onChange={(e) => setTdConfirm(e.target.value)} placeholder={siteTemplate || 'site name'} />
              </Field>
            ) : (
              <div className="text-[11px]" style={{ color: COLORS.warn }}>Admin (dashboard token) required for live teardown</div>
            )
          )}
          <div className="pt-1">
            <button
              className={btnOutline}
              disabled={tdStreaming || !siteTemplate || (!tdDry && (!isAdmin || !tdConfirm.trim()))}
              onClick={teardownStart}
              style={{ borderColor: COLORS.crit, color: COLORS.crit }}
            >
              {tdStreaming ? 'Tearing down…' : 'Tear down this site'}
            </button>
          </div>
        </div>
      </Card>

      {tdLog.length > 0 && (
        <Card title="Teardown log" span={6}>
          <LogView log={tdLog} />
        </Card>
      )}
      {tdResult && (
        <Card title="Teardown result" span={6}>
          <div className="font-mono text-[12px] flex flex-col gap-0.5">
            <div><span className="text-muted">Site: </span>{tdResult.site || siteTemplate || '—'}</div>
            <div>
              <span className="text-muted">DNS zone: </span>{tdResult.dns_zone_fqdn || '—'} {tdResult.dns_zone_deleted ? '(deleted)' : '(kept)'}
            </div>
            <div>
              <span className="text-muted">Subnets: </span>{(tdResult.subnets_deleted || []).length} ·{' '}
              <span className="text-muted">DHCP ranges: </span>{(tdResult.dhcp_ranges_deleted || []).length} ·{' '}
              <span className="text-muted">Hosts: </span>{(tdResult.hosts_deleted || []).length} deleted
            </div>
            {tdResult.dry_run && <div style={{ color: COLORS.warn }}>Dry-run — nothing was deleted.</div>}
          </div>
        </Card>
      )}
      {tdErr && (
        <Card title="Teardown error" span={6}>
          <div className="font-mono text-[12px]" style={{ color: COLORS.crit }}>{tdErr}</div>
        </Card>
      )}
    </div>
  )
}

// ---------- seed demo mode ----------

function RowsRollup({ rows, failedLabel }) {
  const rs = Object.values(rows)
  const total = Object.keys(rows).length
  const failed = rs.filter((r) => r?.error).length
  const done = rs.filter((r) => r && !r.error).length
  if (total === 0) return <Empty>Per-template status appears here once seeding starts.</Empty>
  return (
    <div className="flex flex-col gap-0.5">
      <div className="font-mono text-[12px]" style={{ color: failed ? 'var(--color-crit)' : 'var(--color-muted)' }}>
        {done}/{total} done{failed ? ` · ${failed} ${failedLabel || 'failed'}` : ''}
      </div>
      {Object.entries(rows).filter(([, r]) => r?.error).map(([tpl, r]) => (
        <div key={tpl} className="font-mono text-[12px]" style={{ color: COLORS.crit }}>
          ✕ {tpl}: {r.error}
        </div>
      ))}
    </div>
  )
}

function SeedMode({ isAdmin }) {
  const spacesApi = useApi('/api/ipam/spaces')
  const spaces = spacesApi.data?.spaces ?? []

  const [regions, setRegions] = useState({ amer: true, emea: true, apac: true })
  const [seedSpace, setSeedSpace] = useState('')
  const [seedDry, setSeedDry] = useState(true)
  const [seedLog, setSeedLog] = useState([])
  const [seedRows, setSeedRows] = useState({})
  const [seedStreaming, setSeedStreaming] = useState(false)
  const [seedSummary, setSeedSummary] = useState(null)
  const [seedErr, setSeedErr] = useState(null)
  const seedEsRef = useRef(null)

  const [tdDry, setTdDry] = useState(true)
  const [tdConfirm, setTdConfirm] = useState('')
  const [tdLog, setTdLog] = useState([])
  const [tdRows, setTdRows] = useState({})
  const [tdStreaming, setTdStreaming] = useState(false)
  const [tdSummary, setTdSummary] = useState(null)
  const [tdErr, setTdErr] = useState(null)
  const tdEsRef = useRef(null)

  useEffect(() => () => { seedEsRef.current?.close(); tdEsRef.current?.close() }, [])

  const regionList = Object.keys(regions).filter((r) => regions[r])

  function seedStart() {
    if (seedStreaming || seedEsRef.current) return
    if (!regionList.length) return
    setSeedLog([]); setSeedRows({}); setSeedSummary(null); setSeedErr(null); setSeedStreaming(true)
    const qs = new URLSearchParams({ dry: seedDry ? '1' : '0', regions: regionList.join(',') })
    if (seedSpace) qs.set('ip_space', seedSpace)
    const es = new EventSource('/api/provision/seed-demo/stream?' + qs.toString())
    seedEsRef.current = es
    const stop = () => { seedEsRef.current?.close(); seedEsRef.current = null; setSeedStreaming(false) }
    es.onmessage = (e) => {
      let j = null
      try { j = JSON.parse(e.data) } catch { return }
      setSeedLog((prev) => [...prev, j])
      if (j?.template) setSeedRows((prev) => ({ ...prev, [j.template]: { phase: j.phase, error: j.error } }))
      if (j?.error && !j.template) { setSeedErr(j.error); stop() }
      else if (j?.done) { setSeedSummary(j.summary || null); stop() }
    }
    es.onerror = () => { if (!seedEsRef.current) return; setSeedErr((p) => p || 'Stream connection error'); stop() }
  }

  function teardownStart() {
    if (tdStreaming || tdEsRef.current) return
    if (!tdDry && !isAdmin) return
    if (!tdDry && tdConfirm.trim() !== 'DELETE') return
    if (!regionList.length) return
    setTdLog([]); setTdRows({}); setTdSummary(null); setTdErr(null); setTdStreaming(true)
    const qs = new URLSearchParams({ dry: tdDry ? '1' : '0', regions: regionList.join(','), confirm: tdDry ? '' : 'DELETE' })
    if (seedSpace) qs.set('ip_space', seedSpace)
    const es = new EventSource('/api/teardown/seed-demo/stream?' + qs.toString())
    tdEsRef.current = es
    const stop = () => { tdEsRef.current?.close(); tdEsRef.current = null; setTdStreaming(false) }
    es.onmessage = (e) => {
      let j = null
      try { j = JSON.parse(e.data) } catch { return }
      setTdLog((prev) => [...prev, j])
      if (j?.template) setTdRows((prev) => ({ ...prev, [j.template]: { phase: j.phase, error: j.error } }))
      if (j?.error && !j.template) { setTdErr(j.error); stop() }
      else if (j?.done) { setTdSummary(j.summary || null); stop() }
    }
    es.onerror = () => { if (!tdEsRef.current) return; setTdErr((p) => p || 'Stream connection error'); stop() }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card title="Seed multi-region demo data" span={6}>
        <div className="text-[11px] text-dim mb-3">
          Provisions a full set of demo sites, subnets, and zones across the selected regions from the template library.
          Dry-run is on by default — review the plan before writing real objects.
        </div>
        <div className="flex flex-col gap-3">
          {['amer', 'emea', 'apac'].map((r) => (
            <CheckRow key={r} checked={!!regions[r]} onChange={(v) => setRegions((prev) => ({ ...prev, [r]: v }))} label={r.toUpperCase()} />
          ))}
          <Field label="IP space (override)">
            <select className={inputCls} value={seedSpace} onChange={(e) => setSeedSpace(e.target.value)}>
              <option value="">— template default —</option>
              {spaces.map((sp) => <option key={sp.id} value={sp.name}>{sp.name}</option>)}
            </select>
          </Field>
          <CheckRow checked={seedDry} onChange={setSeedDry} label="Dry-run (no changes made)" />
          <div className="flex items-center gap-2 pt-1">
            <button className={btnOutline} disabled={seedStreaming} onClick={() => { setSeedDry(true); seedStart() }}>Dry-run</button>
            <button className={btnPrimary} disabled={seedStreaming} onClick={seedStart}>
              {seedStreaming ? 'Seeding…' : seedDry ? 'Run dry-run' : 'Seed Demo Data'}
            </button>
          </div>
        </div>
      </Card>

      <Card title="Progress" span={6}>
        <RowsRollup rows={seedRows} />
      </Card>

      <Card title="Live log" span={6}>
        <LogView log={seedLog} />
      </Card>

      {seedSummary && (
        <Card title="Summary" span={6}>
          <div className="font-mono text-[12px]">
            Succeeded: {seedSummary.succeeded ?? 0} · Failed: {seedSummary.failed ?? 0} · Skipped: {seedSummary.skipped ?? 0}
          </div>
        </Card>
      )}
      {seedErr && (
        <Card title="Error" span={6}>
          <div className="font-mono text-[12px]" style={{ color: COLORS.crit }}>{seedErr}</div>
        </Card>
      )}

      <Card title="Tear down demo" note={`permanently deletes every seed-created object in ${seedSpace || 'the default space'}`} span={6}>
        <div className="flex flex-col gap-3">
          <CheckRow checked={tdDry} onChange={setTdDry} label="Dry-run (no changes made)" />
          {!tdDry && (
            isAdmin ? (
              <Field label="Type DELETE to confirm">
                <input className={inputCls} value={tdConfirm} onChange={(e) => setTdConfirm(e.target.value)} placeholder="DELETE" />
              </Field>
            ) : (
              <div className="text-[11px]" style={{ color: COLORS.warn }}>Admin (dashboard token) required for live teardown</div>
            )
          )}
          <div className="pt-1">
            <button
              className={btnOutline}
              disabled={tdStreaming || (!tdDry && (!isAdmin || tdConfirm.trim() !== 'DELETE'))}
              onClick={teardownStart}
              style={{ borderColor: COLORS.crit, color: COLORS.crit }}
            >
              {tdStreaming ? 'Tearing down…' : 'Tear down demo'}
            </button>
          </div>
        </div>
      </Card>

      {tdRows && Object.keys(tdRows).length > 0 && (
        <Card title="Teardown progress" span={6}>
          <RowsRollup rows={tdRows} />
        </Card>
      )}
      {tdLog.length > 0 && (
        <Card title="Teardown log" span={6}>
          <LogView log={tdLog} />
        </Card>
      )}
      {tdSummary && (
        <Card title="Teardown summary" span={6}>
          <div className="font-mono text-[12px]">
            Succeeded: {tdSummary.succeeded ?? 0} · Failed: {tdSummary.failed ?? 0} · Skipped: {tdSummary.skipped ?? 0}
          </div>
        </Card>
      )}
      {tdErr && (
        <Card title="Teardown error" span={6}>
          <div className="font-mono text-[12px]" style={{ color: COLORS.crit }}>{tdErr}</div>
        </Card>
      )}
    </div>
  )
}

// ---------- shared form bits ----------

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-muted">
      {label}
      {children}
    </label>
  )
}

function CheckRow({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}
