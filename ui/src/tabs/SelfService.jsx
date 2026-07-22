import { useState } from 'react'
import { useApi } from '../lib/api.js'
import { COLORS, Card, Empty } from '../components/ui.jsx'

const inputCls = 'px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none'
const RTYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR', 'NS', 'CAA']

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      {children}
    </label>
  )
}

function Result({ result, error }) {
  if (!result && !error) return null
  return (
    <pre
      className="mt-3 p-3 rounded-lg text-xs overflow-auto max-h-[220px] whitespace-pre-wrap"
      style={{
        background: error ? 'var(--pill-crit-bg)' : 'var(--pill-ok-bg)',
        color: error ? 'var(--pill-crit-fg)' : 'var(--pill-ok-fg)',
        border: `1px solid ${error ? COLORS.crit : COLORS.accent}`,
      }}
    >
      {error || JSON.stringify(result, null, 2)}
    </pre>
  )
}

// ---------- allocate ----------

function AllocatePanel() {
  const spacesApi = useApi('/api/ipam/spaces')
  const [space, setSpace] = useState('')
  const blocksApi = useApi(space ? `/api/ipam/blocks?space=${encodeURIComponent(space)}` : null)
  const [block, setBlock] = useState('')
  const subnetsApi = useApi(
    space ? `/api/ipam/subnets?space=${encodeURIComponent(space)}${block ? `&block=${encodeURIComponent(block)}` : ''}` : null
  )
  const [subnetId, setSubnetId] = useState('')
  const [count, setCount] = useState(1)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)

  const spaces = spacesApi.data?.spaces ?? []
  const blocks = blocksApi.data?.blocks ?? []
  const subnets = Array.isArray(subnetsApi.data) ? subnetsApi.data : []

  function submit(dry) {
    if (!subnetId || busy) return
    setBusy(true)
    setResult(null)
    setErr(null)
    fetch('/api/selfservice/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subnet_id: subnetId, count: Number(count) || 1, name, dry }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        setBusy(false)
        if (!r.ok || j.ok === false) return setErr(j.error || `HTTP ${r.status}`)
        setResult(j)
      })
      .catch((e) => {
        setBusy(false)
        setErr(String(e?.message || e))
      })
  }

  return (
    <Card title="Allocate Address" note="pick space → block → subnet">
      <div className="grid grid-cols-2 gap-3">
        <Field label="IP Space">
          <select className={inputCls} value={space} onChange={(e) => { setSpace(e.target.value); setBlock(''); setSubnetId('') }}>
            <option value="">Select space…</option>
            {spaces.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
          </select>
        </Field>
        <Field label="Block">
          <select className={inputCls} value={block} onChange={(e) => { setBlock(e.target.value); setSubnetId('') }} disabled={!space}>
            <option value="">Any block</option>
            {blocks.map((b) => <option key={b.id} value={b.id}>{b.address || b.name || b.id}</option>)}
          </select>
        </Field>
        <Field label="Subnet">
          <select className={inputCls} value={subnetId} onChange={(e) => setSubnetId(e.target.value)} disabled={!space}>
            <option value="">Select subnet…</option>
            {subnets.map((s) => <option key={s.id} value={s.id}>{(s.address || '') + (s.cidr ? `/${s.cidr}` : '')}{s.name ? ` — ${s.name}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Count">
          <input className={inputCls} type="number" min="1" value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Name (optional)">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="host-01" />
        </Field>
      </div>
      <div className="flex gap-2 mt-3">
        <button className={inputCls} disabled={!subnetId || busy} onClick={() => submit(true)}>Dry Run</button>
        <button className={inputCls} disabled={!subnetId || busy} onClick={() => submit(false)} style={{ borderColor: COLORS.accent, color: COLORS.accent }}>
          {busy ? 'Working…' : 'Apply'}
        </button>
      </div>
      {!spacesApi.loading && spaces.length === 0 && <Empty>no IP spaces</Empty>}
      <Result result={result} error={err} />
    </Card>
  )
}

// ---------- dns ----------

function DnsPanel() {
  const zonesApi = useApi('/api/dns/zones')
  const [zoneId, setZoneId] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState('A')
  const [value, setValue] = useState('')
  const [ttl, setTtl] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)

  const zones = zonesApi.data?.zones ?? []

  function body() {
    const b = { zone_id: zoneId, name_in_zone: name, type, value }
    if (ttl !== '') b.ttl = Number(ttl)
    return b
  }

  function apply() {
    if (!zoneId || !value || busy) return
    setBusy(true)
    setResult(null)
    setErr(null)
    fetch('/api/dns/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        setBusy(false)
        if (!r.ok || j.error || j.ok === false) return setErr(j.error || `HTTP ${r.status}`)
        setResult(j)
        setPreview(null)
      })
      .catch((e) => {
        setBusy(false)
        setErr(String(e?.message || e))
      })
  }

  return (
    <Card title="Create DNS Record" note="dry-run previews the request">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Zone">
          <select className={inputCls} value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">Select zone…</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.fqdn || z.name || z.id}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
            {RTYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="host or @" />
        </Field>
        <Field label="TTL (optional)">
          <input className={inputCls} type="number" min="0" value={ttl} onChange={(e) => setTtl(e.target.value)} />
        </Field>
        <Field label="Value">
          <input className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} placeholder="192.0.2.10" />
        </Field>
      </div>
      <div className="flex gap-2 mt-3">
        <button className={inputCls} disabled={!zoneId || !value} onClick={() => { setPreview(body()); setResult(null); setErr(null) }}>Dry Run</button>
        <button className={inputCls} disabled={!zoneId || !value || busy} onClick={apply} style={{ borderColor: COLORS.accent, color: COLORS.accent }}>
          {busy ? 'Working…' : 'Create'}
        </button>
      </div>
      {!zonesApi.loading && zones.length === 0 && <Empty>no DNS zones</Empty>}
      <Result result={preview} error={err} />
      <Result result={result} />
    </Card>
  )
}

// ---------- main ----------

export default function SelfService() {
  return (
    <div className="max-w-[1340px] mx-auto p-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Self-Service</h1>
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[420px] max-w-[640px]"><AllocatePanel /></div>
        <div className="flex-1 min-w-[420px] max-w-[640px]"><DnsPanel /></div>
      </div>
    </div>
  )
}
