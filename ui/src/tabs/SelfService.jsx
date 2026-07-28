import { useEffect, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { Card, COLORS, Empty, PreviewApply, PreviewBox, TabIntro } from '../components/ui.jsx'

const inputCls = 'px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none'
const RTYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR', 'NS', 'CAA']
const EDITABLE_RTYPES = ['A', 'AAAA', 'CNAME', 'PTR', 'NS', 'DNAME', 'TXT', 'MX', 'SRV', 'CAA']

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
  const subnets = subnetsApi.data?.subnets ?? []

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

// ---------- manage records ----------

function FetchError({ error, stale }) {
  if (!error) return null
  return (
    <div className="text-xs mb-2" style={{ color: COLORS.crit }}>
      Could not load current data: {String(error?.message || error)}
      {stale && ' — the list below may be out of date.'}
    </div>
  )
}

function truncNote(data, rows) {
  if (data == null) return null
  if (data.total != null) return `showing ${rows.length} of ${data.total}`
  if (data.truncated === true) return `showing first ${rows.length} — more may exist`
  return null
}

function ManageRecordsPanel() {
  const zonesApi = useApi('/api/dns/zones')
  const [zoneId, setZoneId] = useState('')
  const recordsApi = useApi(zoneId ? `/api/dns/records?zone=${encodeURIComponent(zoneId)}&_limit=200` : null)

  const zones = zonesApi.data?.zones ?? []
  const records = recordsApi.data?.records ?? []
  const recordsUrl = `/api/dns/records?zone=${encodeURIComponent(zoneId)}&_limit=200`

  // edit state — one row editable at a time
  const [editingId, setEditingId] = useState(null)
  const [value, setValue] = useState('')
  const [ttl, setTtl] = useState('')
  const [comment, setComment] = useState('')
  const [held, setHeld] = useState(null) // snapshot taken at Preview time
  const [status, setStatus] = useState('idle')
  const [stale, setStale] = useState(false)
  const [preview, setPreview] = useState(null)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [deleteError, setDeleteError] = useState(null)

  function markStale() {
    if (status === 'previewed') setStale(true)
  }

  function startEdit(row) {
    setEditingId(row.id)
    setValue(row.dns_rdata ?? '')
    setTtl(row.ttl ?? '')
    setComment(row.comment ?? '')
    setHeld(null)
    setStatus('idle'); setStale(false); setPreview(null); setMessage(null); setError(null)
  }

  // `expected` here is the held snapshot (value/ttl/comment as they were when
  // the row was last known-good) — diff the edited fields against IT, not
  // against '', so a deliberate clear is transmitted and an untouched field
  // is not re-sent.
  function buildBody(expected) {
    const b = { id: editingId, expected }
    const expectedValue = expected?.value ?? ''
    const expectedTtl = expected?.ttl != null ? String(expected.ttl) : ''
    const expectedComment = expected?.comment ?? ''
    const ttlStr = ttl === '' ? '' : String(ttl)
    if (value !== expectedValue) b.value = value
    if (ttlStr !== expectedTtl) b.ttl = ttlStr === '' ? '' : Number(ttlStr)
    if (comment !== expectedComment) b.comment = comment
    return b
  }

  function runPreview() {
    const row = records.find((r) => r.id === editingId)
    if (!row) return
    const snapshot = { value: row.dns_rdata, ttl: row.ttl, comment: row.comment }
    setHeld(snapshot)
    setStatus('busy'); setError(null); setMessage(null)
    fetch('/api/dns/records', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...buildBody(snapshot), dry: true }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error) {
          setError(j.error || `HTTP ${r.status}`)
          setStatus('idle'); setPreview(null)
          return
        }
        setPreview(j.would_update || j)
        setStale(false)
        setStatus('previewed')
        setMessage('Preview only — nothing has been committed. Review it, then Update.')
      })
      .catch((e) => { setError(String(e?.message || e)); setStatus('idle'); setPreview(null) })
  }

  // Held snapshot is captured once at Preview time and never refreshed before
  // Apply. Right before firing Apply we re-read the row directly (not
  // useApi's refetch, which isn't promise-based) and compare it against that
  // held snapshot — if anything differs, Apply is aborted rather than
  // silently committing against a record that moved under us.
  function runApply() {
    if (!held) return
    setStatus('busy'); setError(null)
    fetch(recordsUrl, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j) => {
        const fresh = (j.records || []).find((x) => x.id === editingId)
        const currentSnap = fresh ? { value: fresh.dns_rdata, ttl: fresh.ttl, comment: fresh.comment } : null
        // The re-read genuinely succeeded here (a transport/parse failure would
        // have thrown above and hit the outer catch below with its own
        // "could not verify" message). A missing/differing record at this
        // point is a real conflict, not a verification failure.
        const changed = !currentSnap || currentSnap.value !== held.value || currentSnap.ttl !== held.ttl || currentSnap.comment !== held.comment
        if (changed) {
          setError('record changed since you previewed — preview again')
          setStatus('idle'); setPreview(null); setStale(false); setHeld(null)
          return null
        }
        return fetch('/api/dns/records', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...buildBody(held), dry: false }),
        }).then(async (r) => {
          const j2 = await r.json().catch(() => ({}))
          if (!r.ok || j2.error) {
            setError(j2.error || `HTTP ${r.status}`)
            setStatus('idle'); setPreview(null); setHeld(null)
            return
          }
          setPreview(null); setStale(false); setStatus('applied')
          setMessage('DNS record updated.')
          setEditingId(null)
          recordsApi.refetch()
        })
      })
      .catch(() => {
        setError('could not verify the record before applying — try again')
        setStatus('idle'); setPreview(null); setStale(false); setHeld(null)
      })
  }

  // Two-click delete arm — re-reads the row so the confirm label shows the
  // current identity, then auto-disarms after 4s.
  const [armedId, setArmedId] = useState(null)
  const [armLabel, setArmLabel] = useState('')
  const armTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(armTimerRef.current), [])

  function handleDeleteClick(row) {
    if (armedId !== row.id) {
      setDeleteError(null)
      fetch(recordsUrl, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => ({}))
        .then((j) => {
          const fresh = (j.records || []).find((x) => x.id === row.id) || row
          const nm = fresh.name_in_zone || '@'
          setArmLabel(`Click again to delete ${fresh.type} ${nm} -> ${fresh.dns_rdata}`)
          setArmedId(row.id)
          clearTimeout(armTimerRef.current)
          armTimerRef.current = setTimeout(() => setArmedId(null), 4000)
        })
      return
    }
    clearTimeout(armTimerRef.current)
    setArmedId(null)
    setDeleteError(null)
    fetch(`/api/dns/records/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error) {
          setDeleteError(j.error || `HTTP ${r.status} — delete failed, record still exists`)
          return
        }
        recordsApi.refetch()
      })
      .catch((e) => setDeleteError(String(e?.message || e) || 'delete failed, record still exists'))
  }

  const note = truncNote(recordsApi.data, records)

  return (
    <Card title="Manage Records" note="edit or delete existing DNS records">
      <div className="mb-3">
        <Field label="Zone">
          <select
            className={inputCls}
            value={zoneId}
            onChange={(e) => { setZoneId(e.target.value); setEditingId(null); setArmedId(null); setDeleteError(null) }}
          >
            <option value="">Select zone…</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.fqdn || z.name || z.id}</option>)}
          </select>
        </Field>
      </div>

      {!zonesApi.loading && zones.length === 0 && <Empty>no DNS zones</Empty>}

      {zoneId && (
        <>
          <FetchError error={recordsApi.error} stale={records.length > 0} />
          {deleteError && <div className="text-xs mb-2" style={{ color: COLORS.crit }}>{deleteError}</div>}
          {note && <div className="text-[11px] text-dim mb-2">{note}</div>}
          {!recordsApi.loading && !recordsApi.error && records.length === 0 && <Empty>no records in this zone</Empty>}
          {records.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {records.map((row) => {
                const editable = EDITABLE_RTYPES.includes(row.type)
                const isEditing = editingId === row.id
                const isArmed = armedId === row.id
                return (
                  <div key={row.id} className="rounded-lg border border-border p-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-mono text-xs w-[110px] shrink-0 truncate" title={row.name_in_zone || '@'}>{row.name_in_zone || '@'}</span>
                      <span className="text-xs text-muted w-[50px] shrink-0">{row.type}</span>
                      <span className="text-xs text-muted w-[45px] shrink-0">{row.ttl}</span>
                      <span className="text-xs flex-[2] min-w-0 truncate" title={row.dns_rdata}>{row.dns_rdata}</span>
                      <span className="text-xs text-dim flex-1 min-w-0 truncate" title={row.comment}>{row.comment}</span>
                      {editable ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="px-2 py-1 rounded-lg text-xs border border-border"
                            onClick={() => (isEditing ? setEditingId(null) : startEdit(row))}
                          >
                            {isEditing ? 'Cancel' : 'Edit'}
                          </button>
                          <button
                            type="button"
                            className="px-2 py-1 rounded-lg text-xs border border-border"
                            onClick={() => handleDeleteClick(row)}
                          >
                            {isArmed ? 'Confirm delete' : 'Delete'}
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-dim">read-only type</span>
                      )}
                    </div>
                    {isArmed && (
                      <div className="text-[11px] mt-1" style={{ color: 'var(--color-warn)' }}>{armLabel}</div>
                    )}
                    {isEditing && (
                      <div className="mt-2 flex flex-col gap-2">
                        <div className="grid grid-cols-3 gap-2">
                          <Field label="Value">
                            <input className={inputCls} value={value} onChange={(e) => { setValue(e.target.value); markStale() }} />
                          </Field>
                          <Field label="TTL">
                            <input className={inputCls} type="number" min="0" value={ttl} onChange={(e) => { setTtl(e.target.value); markStale() }} />
                          </Field>
                          <Field label="Comment">
                            <input className={inputCls} value={comment} onChange={(e) => { setComment(e.target.value); markStale() }} />
                          </Field>
                        </div>
                        <PreviewApply
                          status={status}
                          stale={stale}
                          onPreview={runPreview}
                          onApply={runApply}
                          applyLabel="Update"
                          error={error}
                          message={message}
                        >
                          <PreviewBox data={preview} note="preview — the record has not been changed yet" />
                        </PreviewApply>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ---------- manage addresses ----------

function ManageAddressesPanel() {
  const spacesApi = useApi('/api/ipam/spaces')
  const [space, setSpace] = useState('')
  const subnetsApi = useApi(space ? `/api/ipam/subnets?space=${encodeURIComponent(space)}` : null)
  const [subnetId, setSubnetId] = useState('')
  const addressesApi = useApi(subnetId ? `/api/ipam/addresses?subnet=${encodeURIComponent(subnetId)}&_limit=200` : null)

  const spaces = spacesApi.data?.spaces ?? []
  const subnets = subnetsApi.data?.subnets ?? []
  const addresses = addressesApi.data?.addresses ?? []
  const addressesUrl = `/api/ipam/addresses?subnet=${encodeURIComponent(subnetId)}&_limit=200`

  const [armedId, setArmedId] = useState(null)
  const [armLabel, setArmLabel] = useState('')
  const [releaseError, setReleaseError] = useState(null)
  const armTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(armTimerRef.current), [])

  function handleRelease(row) {
    if (armedId !== row.id) {
      setReleaseError(null)
      fetch(addressesUrl, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => ({}))
        .then((j) => {
          const fresh = (j.addresses || []).find((x) => x.id === row.id) || row
          setArmLabel(`Click again to release ${fresh.address}${fresh.name ? ` (${fresh.name})` : ''}`)
          setArmedId(row.id)
          clearTimeout(armTimerRef.current)
          armTimerRef.current = setTimeout(() => setArmedId(null), 4000)
        })
      return
    }
    clearTimeout(armTimerRef.current)
    setArmedId(null)
    setReleaseError(null)
    fetch(`/api/ipam/addresses/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error) {
          setReleaseError(j.error || `HTTP ${r.status} — release failed, address still allocated`)
          return
        }
        addressesApi.refetch()
      })
      .catch((e) => setReleaseError(String(e?.message || e) || 'release failed, address still allocated'))
  }

  const note = truncNote(addressesApi.data, addresses)

  return (
    <Card title="Manage Addresses" note="release an allocated address">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="IP Space">
          <select
            className={inputCls}
            value={space}
            onChange={(e) => { setSpace(e.target.value); setSubnetId(''); setArmedId(null); setReleaseError(null) }}
          >
            <option value="">Select space…</option>
            {spaces.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
          </select>
        </Field>
        <Field label="Subnet">
          <select
            className={inputCls}
            value={subnetId}
            onChange={(e) => { setSubnetId(e.target.value); setArmedId(null); setReleaseError(null) }}
            disabled={!space}
          >
            <option value="">Select subnet…</option>
            {subnets.map((s) => <option key={s.id} value={s.id}>{(s.address || '') + (s.cidr ? `/${s.cidr}` : '')}{s.name ? ` — ${s.name}` : ''}</option>)}
          </select>
        </Field>
      </div>

      {!spacesApi.loading && spaces.length === 0 && <Empty>no IP spaces</Empty>}

      {subnetId && (
        <>
          <FetchError error={addressesApi.error} stale={addresses.length > 0} />
          {releaseError && <div className="text-xs mb-2" style={{ color: COLORS.crit }}>{releaseError}</div>}
          {note && <div className="text-[11px] text-dim mb-2">{note}</div>}
          {!addressesApi.loading && !addressesApi.error && addresses.length === 0 && <Empty>no addresses in this subnet</Empty>}
          {addresses.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {addresses.map((row) => {
                const isArmed = armedId === row.id
                return (
                  <div key={row.id} className="rounded-lg border border-border p-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-mono text-xs w-[140px] shrink-0 truncate" title={row.address}>{row.address}</span>
                      <span className="text-xs text-muted w-[80px] shrink-0 truncate" title={row.state}>{row.state}</span>
                      <span className="text-xs flex-1 min-w-0 truncate" title={row.name}>{row.name}</span>
                      <span className="text-xs text-dim flex-1 min-w-0 truncate" title={row.comment}>{row.comment}</span>
                      <button
                        type="button"
                        className="px-2 py-1 rounded-lg text-xs border border-border"
                        onClick={() => handleRelease(row)}
                      >
                        {isArmed ? 'Confirm release' : 'Release'}
                      </button>
                    </div>
                    {isArmed && (
                      <div className="text-[11px] mt-1" style={{ color: 'var(--color-warn)' }}>{armLabel}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ---------- main ----------

// ManageAddressesPanel is finished and tested, but GET /api/ddi/v1/ipam/address
// answers HTTP 400 upstream for every subnet id form, so the panel can only
// render its error state. Flip this to true once that query is corrected —
// nothing else needs to change. See docs/DAILY_CHANGELOG.md 2026-07-28.
const SHOW_MANAGE_ADDRESSES = false

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
      <div className="flex flex-wrap gap-3 mt-3">
        <div className={SHOW_MANAGE_ADDRESSES ? 'flex-1 min-w-[560px]' : 'flex-1'}><ManageRecordsPanel /></div>
        {SHOW_MANAGE_ADDRESSES && <div className="flex-1 min-w-[560px]"><ManageAddressesPanel /></div>}
      </div>
    </div>
  )
}
