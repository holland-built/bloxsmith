import { useState } from 'react'
import { useApi } from '../lib/api.js'
import { Card, Empty, PreviewApply, PreviewBox, TabIntro } from '../components/ui.jsx'

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

// Shared Preview -> Apply driver for both cards. Preview posts with dry:true so
// the server does the validating; apply re-posts the same body with dry:false.
// Every field setter goes through markStale, so a preview can never outlive the
// inputs that produced it.
function useWriteFlow(url) {
  const [status, setStatus] = useState('idle')
  const [stale, setStale] = useState(false)
  const [preview, setPreview] = useState(null)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)

  function markStale() {
    if (status === 'previewed') setStale(true)
  }

  function post(body, dry) {
    setStatus('busy')
    setError(null)
    setMessage(null)
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, dry }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error || j.ok === false) {
          setError(j.error || `HTTP ${r.status}`)
          setStatus('idle')
          setPreview(null)
          return null
        }
        return j
      })
      .catch((e) => {
        setError(String(e?.message || e))
        setStatus('idle')
        setPreview(null)
        return null
      })
  }

  function runPreview(body, applyVerb) {
    post(body, true).then((j) => {
      if (!j) return
      setPreview(j.record || j.addresses || j)
      setStale(false)
      setStatus('previewed')
      setMessage(`Preview only — nothing has been committed. Review it, then ${applyVerb}.`)
    })
  }

  function runApply(body, doneMsg) {
    post(body, false).then((j) => {
      if (!j) return
      setPreview(null)
      setStale(false)
      setStatus('applied')
      setMessage(doneMsg(j))
    })
  }

  return { status, stale, preview, message, error, markStale, runPreview, runApply }
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

  const flow = useWriteFlow('/api/selfservice/allocate')

  const spaces = spacesApi.data?.spaces ?? []
  const blocks = blocksApi.data?.blocks ?? []
  const subnets = Array.isArray(subnetsApi.data) ? subnetsApi.data : []

  const body = () => ({ subnet_id: subnetId, count: Number(count) || 1, name })

  return (
    <Card title="Allocate Address" note="pick space → block → subnet">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="IP Space">
          <select
            className={inputCls}
            value={space}
            onChange={(e) => { setSpace(e.target.value); setBlock(''); setSubnetId(''); flow.markStale() }}
          >
            <option value="">Select space…</option>
            {spaces.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
          </select>
        </Field>
        <Field label="Block">
          <select
            className={inputCls}
            value={block}
            onChange={(e) => { setBlock(e.target.value); setSubnetId(''); flow.markStale() }}
            disabled={!space}
          >
            <option value="">Any block</option>
            {blocks.map((b) => <option key={b.id} value={b.id}>{b.address || b.name || b.id}</option>)}
          </select>
        </Field>
        <Field label="Subnet">
          <select
            className={inputCls}
            value={subnetId}
            onChange={(e) => { setSubnetId(e.target.value); flow.markStale() }}
            disabled={!space}
          >
            <option value="">Select subnet…</option>
            {subnets.map((s) => <option key={s.id} value={s.id}>{(s.address || '') + (s.cidr ? `/${s.cidr}` : '')}{s.name ? ` — ${s.name}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Count">
          <input
            className={inputCls}
            type="number"
            min="1"
            value={count}
            onChange={(e) => { setCount(e.target.value); flow.markStale() }}
          />
        </Field>
        <Field label="Name (optional)">
          <input
            className={inputCls}
            value={name}
            onChange={(e) => { setName(e.target.value); flow.markStale() }}
            placeholder="host-01"
          />
        </Field>
      </div>

      <PreviewApply
        status={flow.status}
        stale={flow.stale}
        disabled={!subnetId}
        onPreview={() => flow.runPreview(body(), 'Allocate')}
        onApply={() => flow.runApply(body(), () => 'Address allocated.')}
        applyLabel="Allocate"
        error={flow.error}
        message={flow.message}
      >
        <PreviewBox data={flow.preview} note="preview — no address has been taken yet" />
      </PreviewApply>

      {!spacesApi.loading && spaces.length === 0 && <Empty>no IP spaces</Empty>}
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

  const flow = useWriteFlow('/api/dns/records')

  const zones = zonesApi.data?.zones ?? []

  function body() {
    const b = { zone_id: zoneId, name_in_zone: name, type, value }
    if (ttl !== '') b.ttl = Number(ttl)
    return b
  }

  return (
    <Card title="Create DNS Record" note="preview is validated by the server">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="Zone">
          <select className={inputCls} value={zoneId} onChange={(e) => { setZoneId(e.target.value); flow.markStale() }}>
            <option value="">Select zone…</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.fqdn || z.name || z.id}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className={inputCls} value={type} onChange={(e) => { setType(e.target.value); flow.markStale() }}>
            {RTYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Name">
          <input className={inputCls} value={name} onChange={(e) => { setName(e.target.value); flow.markStale() }} placeholder="host or @" />
        </Field>
        <Field label="TTL (optional)">
          <input className={inputCls} type="number" min="0" value={ttl} onChange={(e) => { setTtl(e.target.value); flow.markStale() }} />
        </Field>
        <Field label="Value">
          <input className={inputCls} value={value} onChange={(e) => { setValue(e.target.value); flow.markStale() }} placeholder="192.0.2.10" />
        </Field>
      </div>

      <PreviewApply
        status={flow.status}
        stale={flow.stale}
        disabled={!zoneId || !value}
        onPreview={() => flow.runPreview(body(), 'Create')}
        onApply={() => flow.runApply(body(), () => 'DNS record created.')}
        applyLabel="Create"
        error={flow.error}
        message={flow.message}
      >
        <PreviewBox data={flow.preview} note="preview — the record has not been created yet" />
      </PreviewApply>

      {!zonesApi.loading && zones.length === 0 && <Empty>no DNS zones</Empty>}
    </Card>
  )
}

// ---------- main ----------

export default function SelfService() {
  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-1">Self-Service</h1>
      <TabIntro anchor="self-service">
        The two everyday asks, without the full Editor: take the next free address out of a subnet, or add a
        record to an existing DNS zone. Preview checks the request against the server; Apply commits it.
      </TabIntro>
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[420px] max-w-[640px]"><AllocatePanel /></div>
        <div className="flex-1 min-w-[420px] max-w-[640px]"><DnsPanel /></div>
      </div>
    </div>
  )
}
