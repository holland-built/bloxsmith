// This tab's feature set — next-available-subnet allocation from a tagged address
// block, subnet plus forward/reverse DNS zones in one action, record editing, and
// IP allocate/release — is derived from Chris Marrison's BSD-2-Clause
// uddi_self_service_example. See NOTICE.md at the repo root for the attribution
// and the upstream copyright notice.
//
// This comment is a signpost for whoever is reading the source. It is NOT the
// attribution itself: this file is minified into go/web/, so nothing here reaches
// a user. NOTICE.md ships inside the release archive and the container image, and
// that is what carries the notice.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { useSpaceOptions } from '../lib/spaceOptions.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { PageRail, ReadOnlyNote } from '../components/kit.jsx'
import { Card, CardGrid, COLORS, deletedMsg, Empty, FetchError, FIELD_CLS, PreviewApply, PreviewBox, TabIntro } from '../components/ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import FilterSelect from '../components/FilterSelect.jsx'
import { readLast, saveLast, stillThere } from '../lib/lastAllocate.js'
import { tokenFetch } from '../lib/authFetch.js'

const inputCls = FIELD_CLS
const RTYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR', 'NS', 'CAA']
// The four most people need, listed first; the rest sit under "More types".
const COMMON_RTYPES = ['A', 'AAAA', 'CNAME', 'TXT']
const EDITABLE_RTYPES = ['A', 'AAAA', 'CNAME', 'PTR', 'NS', 'DNAME', 'TXT', 'MX', 'SRV', 'CAA']

// A search box plus its dropdown is two controls, so that field is a named
// group rather than one <label> wrapped around both (as in Provision).
function Field({ label, group = false, children }) {
  const id = useId()
  const cls = 'flex flex-col gap-1 text-note text-muted'
  return group ? (
    <div role="group" aria-labelledby={id} className={cls}>
      <span id={id}>{label}</span>
      {children}
    </div>
  ) : (
    <label className={cls}>
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
  // The whole preview answer, for notes the preview body does not carry.
  const [previewReply, setPreviewReply] = useState(null)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  // An edit made while Preview is still loading must leave that preview stale,
  // or Apply would send fields the preview never checked.
  const editedWhileBusy = useRef(false)

  function markStale() {
    if (status === 'previewed') setStale(true)
    if (status === 'busy') editedWhileBusy.current = true
  }

  function post(body, dry) {
    editedWhileBusy.current = false
    setStatus('busy')
    setError(null)
    setMessage(null)
    return tokenFetch(url, {
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
      // Allocate answers with addresses (and, with a DNS name, the record it
      // would make); the addresses are what it takes, so they lead.
      setPreview(j.addresses || j.record || j)
      setPreviewReply(j)
      setStale(editedWhileBusy.current)
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

  return { status, stale, preview, previewReply, message, error, markStale, runPreview, runApply }
}

// ---------- allocate ----------

// Name the address the server actually reserved; it can differ from the preview.
function allocatedMsg(j, dnsName) {
  const got = (j?.addresses || []).map((a) => a?.address).filter(Boolean)
  if (got.length === 1 && dnsName && j?.record?.ok) return `Done. ${got[0]} is yours, and ${dnsName} now points to it.`
  if (got.length === 1) return `Done. ${got[0]} is yours.`
  if (got.length > 1) return `Done. These ${got.length} addresses are yours: ${got.join(', ')}.`
  return 'Address allocated.'
}

// Forward and reverse zones together made one list too long to search
// (owner, 2026-11-09). Reverse zones end in in-addr.arpa or ip6.arpa and hold
// PTR records; every other record type lives in a forward zone.
const zoneName = (z) => String(z.fqdn || z.name || z.id || '')
const isReverseZone = (z) => /(^|\.)(in-addr|ip6)\.arpa\.?$/i.test(zoneName(z))
const zoneOptions = (zones, reverse) => zones.filter((z) => isReverseZone(z) === reverse).map((z) => ({ value: z.id, label: zoneName(z) }))

const subnetLabel = (s) => (s.address || '') + (s.cidr ? `/${s.cidr}` : '') + (s.name ? ` — ${s.name}` : '')

// The preview said what it would do as raw JSON. Say it as a sentence; the
// JSON stays under Details for anyone checking the ids.
function allocateSentence(preview, subnet, name, dnsName, ptr) {
  const rows = Array.isArray(preview) ? preview : null
  const addrs = rows?.map((r) => r?.address).filter(Boolean) ?? []
  if (!addrs.length) return null
  const list = addrs.length === 1 ? addrs[0] : `${addrs.length} addresses (${addrs.join(', ')})`
  const where = subnet ? ` in subnet ${subnetLabel(subnet)}` : ''
  const called = name.trim() ? `, named ${name.trim()}` : ''
  const dns = dnsName ? ` It will also point ${dnsName} to it${ptr ? ', with a reverse record' : ''}.` : ''
  return `This will take ${list}${where}${called}.${dns}`
}

function AllocatePanel({ panelId }) {
  const spacesApi = useApi('/api/ipam/spaces')
  const spaceOpts = useSpaceOptions()
  const [space, setSpace] = useState('')
  const blocksApi = useApi(space ? `/api/ipam/blocks?space=${encodeURIComponent(space)}` : null)
  const [block, setBlock] = useState('')
  const subnetsApi = useApi(
    space ? `/api/ipam/subnets?space=${encodeURIComponent(space)}${block ? `&block=${encodeURIComponent(block)}` : ''}` : null
  )
  const [subnetId, setSubnetId] = useState('')
  const [count, setCount] = useState(1)
  const [name, setName] = useState('')
  // "Also give it a DNS name": the server reserves the address and makes the
  // record in one step, and hands the address back if the record fails.
  const [dnsOn, setDnsOn] = useState(false)
  const [zoneId, setZoneId] = useState('')
  const [ptr, setPtr] = useState(false)
  const zonesApi = useApi(dnsOn ? '/api/dns/zones' : null)
  const zones = zonesApi.data?.zones ?? []

  const flow = useWriteFlow('/api/selfservice/allocate')

  const spaces = spacesApi.data?.spaces ?? []
  const blocks = blocksApi.data?.blocks ?? []
  const subnets = subnetsApi.data?.subnets ?? []

  // Start where the last address was handed out, once, and only with ids the
  // lists still hold. Anyone who has already picked keeps their pick.
  const tenant = useApi('/api/vault/status').data?.active
  // `pending` is the remembered pick while its subnet list loads; it belongs
  // to one space, so a list for any other space never fills it.
  const tried = useRef(false)
  const pending = useRef(null)
  useEffect(() => {
    if (tried.current || !tenant || !spacesApi.data) return
    tried.current = true
    const last = readLast(tenant)
    const s = last && !space ? stillThere(last.space, (spacesApi.data.spaces ?? []).map((x) => x.id)) : ''
    if (!s) return
    pending.current = last
    setSpace(s)
  }, [tenant, spacesApi.data, space])
  useEffect(() => {
    const want = pending.current
    if (!want || !subnetsApi.data) return
    pending.current = null
    if (want.space !== space || block || subnetId) return
    const id = stillThere(want.subnet, (subnetsApi.data.subnets ?? []).map((x) => x.id))
    if (id) setSubnetId(id)
  }, [subnetsApi.data, space, subnetId, block])

  // "Any network with room": left unpicked, the subnet with the most free
  // addresses in the chosen space (and block) is used. Preview pins it, so a
  // refreshed list cannot move Allocate to a network the preview did not name.
  const want = Number(count) || 1
  const roomiest = useMemo(() => [...(subnetsApi.data?.subnets ?? [])]
    .filter((s) => Number(s.utilization?.free) >= want)
    .sort((a, b) => Number(b.utilization?.free) - Number(a.utilization?.free))[0], [subnetsApi.data, want])
  const target = subnetId || roomiest?.id || ''
  const targetSubnet = subnets.find((s) => s.id === target)
  // One address gets one name; the server names only the first.
  const single = (Number(count) || 1) === 1
  const zone = zones.find((z) => z.id === zoneId)
  const dnsName = dnsOn && single && zone && name.trim() ? `${name.trim()}.${String(zone.fqdn || zone.name || '').replace(/\.$/, '')}` : ''
  const dnsIncomplete = dnsOn && single && !dnsName
  const body = () => ({
    subnet_id: target,
    count: Number(count) || 1,
    name,
    ...(dnsName ? { dns: { zone_id: zoneId, name: name.trim(), type: String(targetSubnet?.address || '').includes(':') ? 'AAAA' : 'A', create_ptr: ptr } } : {}),
  })

  return (
    <Card panelId={panelId} span={3} title="Get an address" note="pick space → block → subnet">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <Field label="IP Space" group>
          <FilterSelect
            label="IP Space"
            value={space}
            onChange={(v) => { setSpace(v); setBlock(''); setSubnetId(''); flow.markStale() }}
            options={spaceOpts.options.length ? spaceOpts.options : spaces.map((s) => ({ value: s.id, label: s.name || s.id }))}
            placeholder="Select space…"
          />
        </Field>
        <Field label="Block" group>
          <FilterSelect
            label="Block"
            value={block}
            onChange={(v) => { setBlock(v); setSubnetId(''); flow.markStale() }}
            options={blocks.map((b) => ({ value: b.id, label: b.address ? `${b.address}${b.cidr ? `/${b.cidr}` : ''}${b.name ? ` — ${b.name}` : ''}` : b.name || b.id }))}
            placeholder="Any block"
            disabled={!space}
          />
        </Field>
        <Field label="Subnet" group>
          <FilterSelect
            label="Subnet"
            value={subnetId}
            onChange={(v) => { setSubnetId(v); flow.markStale() }}
            options={subnets.map((s) => ({ value: s.id, label: subnetLabel(s) }))}
            placeholder={roomiest ? `Any network with room (now ${subnetLabel(roomiest)})` : 'Select subnet…'}
            disabled={!space}
          />
        </Field>
        <Field label="Count">
          <input {...MACHINE_TEXT}
            className={inputCls}
            type="number"
            min="1"
            value={count}
            onChange={(e) => { setCount(e.target.value); flow.markStale() }}
          />
        </Field>
        <Field label="Name (optional)">
          <input {...MACHINE_TEXT}
            className={inputCls}
            value={name}
            onChange={(e) => { setName(e.target.value); flow.markStale() }}
            placeholder="host-01"
          />
        </Field>
      </div>

      <div className="flex flex-col gap-2 mb-3 text-copy">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={dnsOn} disabled={!single} onChange={(e) => { setDnsOn(e.target.checked); flow.markStale() }} />
          Also give it a DNS name
          {!single && <span className="text-note text-muted">(one address at a time)</span>}
        </label>
        {dnsOn && single && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-6">
            <Field label="Zone" group>
              <FilterSelect
                label="Zone"
                value={zoneId}
                onChange={(v) => { setZoneId(v); flow.markStale() }}
                options={zoneOptions(zones, false)}
                placeholder="Select zone…"
              />
            </Field>
            <p className="text-note text-muted self-end">
              {dnsName ? `It will be ${dnsName}.` : name.trim() ? 'Pick the zone the name goes in.' : 'Type a Name above; it becomes the DNS name.'}
            </p>
            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" checked={ptr} onChange={(e) => { setPtr(e.target.checked); flow.markStale() }} />
              Also create the reverse (PTR) record
            </label>
            <FetchError error={zonesApi.error} stale={zones.length > 0} />
          </div>
        )}
      </div>

      <PreviewApply
        status={flow.status}
        stale={flow.stale}
        disabled={!target || dnsIncomplete}
        onPreview={() => { if (!subnetId && target) setSubnetId(target); flow.runPreview(body(), 'Allocate') }}
        onApply={() => flow.runApply(body(), (j) => { saveLast(tenant, space, target); return allocatedMsg(j, dnsName) })}
        applyLabel="Allocate"
        error={flow.error}
        message={flow.message}
      >
        <PreviewBox
          data={flow.preview}
          note="preview — no address has been taken yet"
          summary={flow.stale ? null : allocateSentence(flow.preview, targetSubnet, name, dnsName, ptr)}
        />
      </PreviewApply>

      <FetchError error={spacesApi.error} stale={spaces.length > 0} />
      <FetchError error={blocksApi.error} stale={blocks.length > 0} />
      <FetchError error={subnetsApi.error} stale={subnets.length > 0} />
      {!spacesApi.loading && !spacesApi.error && spaces.length === 0 && <Empty>no IP spaces</Empty>}
    </Card>
  )
}

// ---------- dns ----------

function DnsPanel({ panelId }) {
  const zonesApi = useApi('/api/dns/zones')
  const [zoneId, setZoneId] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState('A')
  const [value, setValue] = useState('')
  const [ttl, setTtl] = useState('')
  const [ptr, setPtr] = useState(false)

  const flow = useWriteFlow('/api/dns/records')

  const zones = zonesApi.data?.zones ?? []
  // A reverse record exists only for an address, so the box is offered for A and AAAA.
  const canPtr = type === 'A' || type === 'AAAA'

  function body() {
    const b = { zone_id: zoneId, name_in_zone: name, type, value }
    if (ttl !== '') b.ttl = Number(ttl)
    if (canPtr && ptr) b.create_ptr = true
    return b
  }

  // The preview as a sentence; the record itself stays under Details.
  const zone = zones.find((z) => z.id === zoneId)
  const fqdn = zone ? String(zone.fqdn || zone.name || '').replace(/\.$/, '') : ''
  const owner = !name.trim() || name.trim() === '@' ? fqdn : `${name.trim()}.${fqdn}`
  // After an edit the old preview no longer matches the form, so it says nothing.
  const sentence = flow.preview && !flow.stale
    ? `This will create ${type} ${owner} → ${value.trim()}${canPtr && ptr ? ', with a reverse record' : ''}.` +
      (flow.previewReply?.duplicate_check === 'unavailable' ? " It could not check whether this record already exists." : ' No identical record exists.')
    : null

  return (
    <Card panelId={panelId} span={3} title="Create DNS Record" note="preview is validated by the server">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <Field label={type === 'PTR' ? 'Zone (reverse zones)' : 'Zone'} group>
          <FilterSelect
            label="Zone"
            value={zoneId}
            onChange={(v) => { setZoneId(v); flow.markStale() }}
            options={zoneOptions(zones, type === 'PTR')}
            placeholder="Select zone…"
          />
        </Field>
        <Field label="Type">
          <select className={inputCls} value={type} onChange={(e) => {
            // PTR lives in reverse zones and everything else in forward ones, so
            // crossing that line drops a zone the new list no longer holds.
            if ((e.target.value === 'PTR') !== (type === 'PTR')) setZoneId('')
            setType(e.target.value); flow.markStale()
          }}>
            {COMMON_RTYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            <optgroup label="More types">
              {RTYPES.filter((t) => !COMMON_RTYPES.includes(t)).map((t) => <option key={t} value={t}>{t}</option>)}
            </optgroup>
          </select>
        </Field>
        <Field label="Name">
          <input {...MACHINE_TEXT} className={inputCls} value={name} onChange={(e) => { setName(e.target.value); flow.markStale() }} placeholder="host or @" />
        </Field>
        <Field label="Value">
          <input {...MACHINE_TEXT} className={inputCls} value={value} onChange={(e) => { setValue(e.target.value); flow.markStale() }} placeholder="192.0.2.10" />
        </Field>
      </div>
      <details className="mb-3 text-note text-muted" open={ttl !== ''}>
        <summary className="cursor-pointer">More options</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          <Field label="TTL (optional)">
            <input {...MACHINE_TEXT} className={inputCls} type="number" min="0" value={ttl} onChange={(e) => { setTtl(e.target.value); flow.markStale() }} />
          </Field>
        </div>
      </details>
      {canPtr && (
        <label className="flex items-center gap-2 mb-3 text-copy">
          <input type="checkbox" checked={ptr} onChange={(e) => { setPtr(e.target.checked); flow.markStale() }} />
          Also create the reverse (PTR) record
        </label>
      )}

      <PreviewApply
        status={flow.status}
        stale={flow.stale}
        disabled={!zoneId || !value}
        onPreview={() => flow.runPreview(body(), 'Create')}
        onApply={() => flow.runApply(body(), () => `Done. ${owner} now points to ${value.trim()}${canPtr && ptr ? ', and its reverse record is made' : ''}.`)}
        applyLabel="Create"
        error={flow.error}
        message={flow.message}
      >
        <PreviewBox data={flow.preview} note="preview — the record has not been created yet" summary={sentence} />
      </PreviewApply>

      <FetchError error={zonesApi.error} stale={zones.length > 0} />
      {!zonesApi.loading && !zonesApi.error && zones.length === 0 && <Empty>no DNS zones</Empty>}
    </Card>
  )
}

// ---------- manage records ----------

function truncNote(data, rows) {
  if (data == null) return null
  if (data.total != null) return `showing ${rows.length} of ${data.total}`
  if (data.truncated === true) return `showing first ${rows.length} — more may exist`
  return null
}

// A list that starts with the first 200 rows and can load the next 200 on
// request, so nothing past the first page is out of reach.
function usePagedList(url) {
  const api = useApi(url)
  const [more, setMore] = useState({ url: null, rows: [], data: null, busy: false, error: null })
  // Rows loaded by "Show more" belong to the list they were loaded for.
  const extra = more.url === url ? more : { rows: [], data: null, busy: false, error: null }
  return { api, extra, setMore, url }
}

function pagedRows(list, key) {
  // After a delete the first page moves up by one, so a row can arrive on both
  // pages; show it once.
  const seen = new Set()
  return [...(list.api.data?.[key] ?? []), ...list.extra.rows].filter((x) => !seen.has(x.id) && seen.add(x.id))
}

function pagedHasMore(list, shown) {
  const last = list.extra.data ?? list.api.data
  if (!last) return false
  if (last.total != null) return shown < last.total
  return last.truncated === true
}

function showMore(list, key, shown) {
  const { url, setMore } = list
  setMore((m) => ({ ...(m.url === url ? m : { rows: [], data: null }), url, busy: true, error: null }))
  fetch(`${url}&_offset=${shown}`, { cache: 'no-store' })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`)
      setMore((m) => (m.url === url ? { ...m, rows: [...m.rows, ...(j[key] ?? [])], data: j, busy: false } : m))
    })
    .catch((e) => setMore((m) => (m.url === url ? { ...m, busy: false, error: String(e?.message || e) } : m)))
}

// Keep rows loaded by "Show more" in step with a write: drop a deleted row,
// or update an edited one in place, so the list doesn't show old details.
function patchMore(list, id, fields) {
  list.setMore((m) => ({
    ...m,
    rows: fields ? m.rows.map((x) => (x.id === id ? { ...x, ...fields } : x)) : m.rows.filter((x) => x.id !== id),
  }))
}

function ShowMore({ list }) {
  if (!list.canMore && !list.extra.error) return null
  return (
    <div className="mt-2 flex items-center gap-2">
      {list.canMore && (
        <button type="button" className="text-note px-2 py-1 rounded-control border border-border hover:border-border-hover disabled:opacity-40" onClick={list.more} disabled={list.extra.busy}>
          {list.extra.busy ? 'Loading…' : 'Show 200 more'}
        </button>
      )}
      {list.extra.error && <span className="text-note" style={{ color: 'var(--color-crit)' }}>Couldn't load more: {list.extra.error}</span>}
    </div>
  )
}

// The search box over a managed list. It waits a moment after typing stops,
// so each key press doesn't send a request.
function useSearchTerm() {
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setTerm(text.trim()), 300)
    return () => clearTimeout(id)
  }, [text])
  return { text, setText, term }
}

function ManageRecordsPanel({ panelId, span }) {
  const zonesApi = useApi('/api/dns/zones')
  const [zoneId, setZoneId] = useState('')
  const [reverse, setReverse] = useState(false)
  const search = useSearchTerm()
  const listUrl = zoneId ? `/api/dns/records?zone=${encodeURIComponent(zoneId)}&_limit=200${search.term ? `&q=${encodeURIComponent(search.term)}` : ''}` : null
  const paged = usePagedList(listUrl)
  const recordsApi = paged.api

  const zones = zonesApi.data?.zones ?? []
  const records = pagedRows(paged, 'records')
  const list = { ...paged, canMore: pagedHasMore(paged, records.length), more: () => showMore(paged, 'records', records.length) }
  // Re-read one record by its exact name and type, wherever it sits in the list.
  const rereadUrl = (row) => `/api/dns/records?zone=${encodeURIComponent(zoneId)}&_limit=200&name=${encodeURIComponent(row.name_in_zone ?? '')}&type=${encodeURIComponent(row.type ?? '')}`

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
  // Panel-level confirmation — the row-scoped `message` above dies with the row
  // it lives in (Edit closes / Delete removes the row in the same tick), so a
  // successful apply/delete needs its own state that survives that unmount.
  const [panelMessage, setPanelMessage] = useState(null)
  const editedWhileBusy = useRef(false)

  function markStale() {
    if (status === 'previewed') setStale(true)
    if (status === 'busy') editedWhileBusy.current = true
  }

  function startEdit(row) {
    setEditingId(row.id)
    setValue(row.dns_rdata ?? '')
    setTtl(row.ttl ?? '')
    setComment(row.comment ?? '')
    setHeld(null)
    setStatus('idle'); setStale(false); setPreview(null); setMessage(null); setError(null)
    setPanelMessage(null)
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
    editedWhileBusy.current = false
    setStatus('busy'); setError(null); setMessage(null)
    tokenFetch('/api/dns/records', {
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
        setStale(editedWhileBusy.current)
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
    const editing = records.find((r) => r.id === editingId)
    if (!editing) return
    setStatus('busy'); setError(null)
    fetch(rereadUrl(editing), { cache: 'no-store' })
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
        return tokenFetch('/api/dns/records', {
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
          setEditingId(null)
          setPanelMessage('DNS record updated.')
          const b = buildBody(held)
          patchMore(paged, editingId, {
            ...(b.value !== undefined && { dns_rdata: b.value }),
            ...(b.ttl !== undefined && { ttl: b.ttl === '' ? null : b.ttl }),
            ...(b.comment !== undefined && { comment: b.comment }),
          })
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
      setPanelMessage(null)
      // Arm only on a fresh read that still finds the row, so the confirm
      // label never shows details that may have changed.
      fetch(rereadUrl(row), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((j) => {
          const fresh = j && (j.records || []).find((x) => x.id === row.id)
          if (!fresh) {
            setDeleteError(j ? 'That record is no longer there. The list has been refreshed.' : "Couldn't re-check that record, so it wasn't deleted. Try again.")
            if (j) { patchMore(paged, row.id); recordsApi.refetch() }
            return
          }
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
    tokenFetch(`/api/dns/records/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error) {
          setDeleteError(j.error || `HTTP ${r.status} — delete failed, record still exists`)
          return
        }
        setPanelMessage(deletedMsg(j, 'DNS record'))
        patchMore(paged, row.id)
        recordsApi.refetch()
      })
      .catch((e) => setDeleteError(String(e?.message || e) || 'delete failed, record still exists'))
  }

  const note = truncNote(paged.extra.data ?? recordsApi.data, records)

  return (
    <Card panelId={panelId} span={span} title="Manage Records" note="edit or delete existing DNS records">
      <div className="mb-3">
        <fieldset className="flex gap-4 mb-2 text-copy">
          <legend className="sr-only">Which zones to list</legend>
          {[[false, 'Forward zones'], [true, 'Reverse zones']].map(([rev, text]) => (
            <label key={text} className="flex items-center gap-2">
              <input type="radio" name={`${panelId}-zone-kind`} checked={reverse === rev} onChange={() => { setReverse(rev); setZoneId(''); setEditingId(null); setArmedId(null); setDeleteError(null); setPanelMessage(null) }} />
              {text}
            </label>
          ))}
        </fieldset>
        <Field label="Zone" group>
          <FilterSelect
            label="Zone"
            value={zoneId}
            onChange={(v) => { setZoneId(v); setEditingId(null); setArmedId(null); setDeleteError(null); setPanelMessage(null) }}
            options={zoneOptions(zones, reverse)}
            placeholder="Select zone…"
          />
        </Field>
      </div>

      <FetchError error={zonesApi.error} stale={zones.length > 0} />
      {!zonesApi.loading && !zonesApi.error && zones.length === 0 && <Empty>no DNS zones</Empty>}

      {zoneId && (
        <>
          <FetchError error={recordsApi.error} stale={records.length > 0} />
          {deleteError && <div className="text-note mb-2" style={{ color: COLORS.crit }}>{deleteError}</div>}
          {!deleteError && panelMessage && <div className="text-note mb-2" style={{ color: COLORS.ok }}>{panelMessage}</div>}
          <input
            {...MACHINE_TEXT}
            type="search"
            className={`${inputCls} w-full mb-2`}
            aria-label="Find a record"
            placeholder="Find a record by name or value"
            value={search.text}
            onChange={(e) => search.setText(e.target.value)}
          />
          {note && <div className="text-note text-dim mb-2">{note}</div>}
          {!recordsApi.loading && !recordsApi.error && records.length === 0 && <Empty>{search.term ? 'no records match that search' : 'no records in this zone'}</Empty>}
          {records.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {records.map((row) => {
                const editable = EDITABLE_RTYPES.includes(row.type)
                const isEditing = editingId === row.id
                const isArmed = armedId === row.id
                return (
                  <div key={row.id} className="rounded-control border border-border p-2">
                    <div className="flex items-center gap-2 text-copy">
                      <span className="font-mono text-note w-[110px] shrink-0 truncate" title={row.name_in_zone || '@'}>{row.name_in_zone || '@'}</span>
                      <span className="text-note text-muted w-[50px] shrink-0">{row.type}</span>
                      <span className="text-note text-muted w-[45px] shrink-0">{row.ttl}</span>
                      <span className="text-note flex-[2] min-w-0 truncate" title={row.dns_rdata}>{row.dns_rdata}</span>
                      <span className="text-note text-dim flex-1 min-w-0 truncate" title={row.comment}>{row.comment}</span>
                      {editable ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="px-2 py-1 rounded-control text-note border border-border"
                            onClick={() => (isEditing ? setEditingId(null) : startEdit(row))}
                          >
                            {isEditing ? 'Cancel' : 'Edit'}
                          </button>
                          <button
                            type="button"
                            className="px-2 py-1 rounded-control text-note border border-border"
                            onClick={() => handleDeleteClick(row)}
                          >
                            {isArmed ? 'Confirm delete' : 'Delete'}
                          </button>
                        </div>
                      ) : (
                        <span className="text-note text-dim">read-only type</span>
                      )}
                    </div>
                    {isArmed && (
                      <div className="text-note mt-1" style={{ color: 'var(--color-warn)' }}>{armLabel}</div>
                    )}
                    {isEditing && (
                      <div className="mt-2 flex flex-col gap-2">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <Field label="Value">
                            <input {...MACHINE_TEXT} className={inputCls} value={value} onChange={(e) => { setValue(e.target.value); markStale() }} />
                          </Field>
                          <Field label="TTL">
                            <input {...MACHINE_TEXT} className={inputCls} type="number" min="0" value={ttl} onChange={(e) => { setTtl(e.target.value); markStale() }} />
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
          <ShowMore list={list} />
        </>
      )}
    </Card>
  )
}

// ---------- manage addresses ----------

function ManageAddressesPanel({ panelId }) {
  const spacesApi = useApi('/api/ipam/spaces')
  const [space, setSpace] = useState('')
  const subnetsApi = useApi(space ? `/api/ipam/subnets?space=${encodeURIComponent(space)}` : null)
  const [subnetId, setSubnetId] = useState('')
  const search = useSearchTerm()
  const listUrl = subnetId ? `/api/ipam/addresses?subnet=${encodeURIComponent(subnetId)}&_limit=200${search.term ? `&q=${encodeURIComponent(search.term)}` : ''}` : null
  const paged = usePagedList(listUrl)
  const addressesApi = paged.api

  const spaces = spacesApi.data?.spaces ?? []
  const subnets = subnetsApi.data?.subnets ?? []
  const addresses = pagedRows(paged, 'addresses')
  const list = { ...paged, canMore: pagedHasMore(paged, addresses.length), more: () => showMore(paged, 'addresses', addresses.length) }
  // Re-read one address by its exact IP, wherever it sits in the list.
  const rereadUrl = (row) => `/api/ipam/addresses?subnet=${encodeURIComponent(subnetId)}&_limit=200&q=${encodeURIComponent(row.address ?? '')}`

  const [armedId, setArmedId] = useState(null)
  const [armLabel, setArmLabel] = useState('')
  const [releaseError, setReleaseError] = useState(null)
  const armTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(armTimerRef.current), [])

  function handleRelease(row) {
    if (armedId !== row.id) {
      setReleaseError(null)
      fetch(rereadUrl(row), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((j) => {
          const fresh = j && (j.addresses || []).find((x) => x.id === row.id)
          if (!fresh) {
            setReleaseError(j ? 'That address is no longer there. The list has been refreshed.' : "Couldn't re-check that address, so it wasn't released. Try again.")
            if (j) { patchMore(paged, row.id); addressesApi.refetch() }
            return
          }
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
    tokenFetch(`/api/ipam/addresses/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error) {
          setReleaseError(j.error || `HTTP ${r.status} — release failed, address still allocated`)
          return
        }
        patchMore(paged, row.id)
        addressesApi.refetch()
      })
      .catch((e) => setReleaseError(String(e?.message || e) || 'release failed, address still allocated'))
  }

  const note = truncNote(paged.extra.data ?? addressesApi.data, addresses)

  return (
    <Card panelId={panelId} span={3} title="Manage Addresses" note="release an allocated address">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <Field label="IP Space" group>
          <FilterSelect
            label="IP Space"
            value={space}
            onChange={(v) => { setSpace(v); setSubnetId(''); setArmedId(null); setReleaseError(null) }}
            options={spaces.map((s) => ({ value: s.id, label: s.name || s.id }))}
            placeholder="Select space…"
          />
        </Field>
        <Field label="Subnet" group>
          <FilterSelect
            label="Subnet"
            value={subnetId}
            onChange={(v) => { setSubnetId(v); setArmedId(null); setReleaseError(null) }}
            options={subnets.map((s) => ({ value: s.id, label: subnetLabel(s) }))}
            placeholder="Select subnet…"
            disabled={!space}
          />
        </Field>
      </div>

      <FetchError error={spacesApi.error} stale={spaces.length > 0} />
      <FetchError error={subnetsApi.error} stale={subnets.length > 0} />
      {!spacesApi.loading && !spacesApi.error && spaces.length === 0 && <Empty>no IP spaces</Empty>}

      {subnetId && (
        <>
          <FetchError error={addressesApi.error} stale={addresses.length > 0} />
          {releaseError && <div className="text-note mb-2" style={{ color: COLORS.crit }}>{releaseError}</div>}
          <input
            {...MACHINE_TEXT}
            type="search"
            className={`${inputCls} w-full mb-2`}
            aria-label="Find an address"
            placeholder="Find by full IP address or comment"
            value={search.text}
            onChange={(e) => search.setText(e.target.value)}
          />
          {note && <div className="text-note text-dim mb-2">{note}</div>}
          {!addressesApi.loading && !addressesApi.error && addresses.length === 0 && <Empty>{search.term ? 'no addresses match that search' : 'no addresses in this subnet'}</Empty>}
          {addresses.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {addresses.map((row) => {
                const isArmed = armedId === row.id
                return (
                  <div key={row.id} className="rounded-control border border-border p-2">
                    <div className="flex items-center gap-2 text-copy">
                      <span className="font-mono text-note w-[140px] shrink-0 truncate" title={row.address}>{row.address}</span>
                      <span className="text-note text-muted w-[80px] shrink-0 truncate" title={row.state}>{row.state}</span>
                      <span className="text-note flex-1 min-w-0 truncate" title={row.name}>{row.name}</span>
                      <span className="text-note text-dim flex-1 min-w-0 truncate" title={row.comment}>{row.comment}</span>
                      <button
                        type="button"
                        className="px-2 py-1 rounded-control text-note border border-border"
                        onClick={() => handleRelease(row)}
                      >
                        {isArmed ? 'Confirm release' : 'Release'}
                      </button>
                    </div>
                    {isArmed && (
                      <div className="text-note mt-1" style={{ color: 'var(--color-warn)' }}>{armLabel}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <ShowMore list={list} />
        </>
      )}
    </Card>
  )
}

// ---------- main ----------

// ManageAddressesPanel is live — the server filter field was fixed (parent, not subnet).
const SHOW_MANAGE_ADDRESSES = true

export default function SelfService() {
  const ro = useReadOnly()
  return (
    <PageRail>
    <div className="w-full px-6 py-5">
      <h1 className="text-copy font-semibold tracking-tight mb-1">Get an address</h1>
      <TabIntro>Take the next free address from a subnet, or add a record to a DNS zone.</TabIntro>
      <ReadOnlyNote ro={ro} what="Preview works, because it changes nothing. Apply is off." />
      {/* The two flex rows these panels used to sit in are one CardGrid now, and
          the div around each panel is gone rather than kept: a div wrapping a
          Card hides that Card's panelId from the grid, which reads props.panelId
          off its DIRECT children (lib/layout.js sortByOrder) and logs a console
          error when it cannot see one. The panelId literal therefore sits on the
          call site and each panel forwards it to its Card.

          span={3} is what the flex widths already resolved to: two `flex-1`
          items in a row are (W - gap) / 2 wide each, and three of six tracks is
          3t + 2g = (W - g) / 2 — the same number, at xl, at md (SPAN_CLASS[3]
          renders col-span-2 of 4) and stacked at the base 2-track grid. The one
          place it differs is a viewport wide enough for the old
          `max-w-[640px]` to bind (content wider than ~1292px, i.e. around 1340
          and up): Allocate and Create DNS Record now grow with the row instead
          of stopping at 640px and leaving the right of the page empty. */}
      <CardGrid layoutKey="selfservice">
        <AllocatePanel panelId="selfservice-allocate" />
        <DnsPanel panelId="selfservice-create-record" />
        <ManageRecordsPanel panelId="selfservice-manage-records" span={SHOW_MANAGE_ADDRESSES ? 3 : 6} />
        {SHOW_MANAGE_ADDRESSES && <ManageAddressesPanel key="selfservice-manage-addresses" panelId="selfservice-manage-addresses" />}
      </CardGrid>
    </div>
    </PageRail>
  )
}
