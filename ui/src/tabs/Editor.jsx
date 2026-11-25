import { useEffect, useRef, useState } from 'react'
import { ColumnHeading, DevicesInput, FormColumns, PageTitle, ReadOnlyNote } from '../components/kit.jsx'
import { PrefixInput } from '../components/PrefixInput.jsx'
import { COLORS, deletedMsg, Empty, FetchError, FieldError, FIELD_CLS, PreviewApply, PreviewBox, TabIntro } from '../components/ui.jsx'
import FilterSelect from '../components/FilterSelect.jsx'
import { SHARE_PICKER, useApi } from '../lib/api.js'
import { withSize } from '../lib/sizes.js'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { tokenFetch } from '../lib/authFetch.js'
import MadeList from '../components/MadeList.jsx'
import { ConfirmStep } from '../components/DeleteCheck.jsx'
import CheckedAgainst from '../components/CheckedAgainst.jsx'
import { useNetworkPrefill } from '../lib/prefill.js'
import { useHashParams } from '../lib/hash.js'
import { canDelete as madeKind, checkDelete, confirmDelete, whoMade } from '../lib/madeDelete.js'
import { failureText } from '../lib/api.js'
import { writeFailureText } from '../lib/writeFailure.js'

const inputCls = `${FIELD_CLS} w-full`
const MISSING = 'Fill in this field.'

// Things Infoblox knows by an internal ID (a DNS view, an address block, an
// IP space) are picked from a list by name, never typed (owner: "a name, not
// an internal id"). kind 'view' | 'block' | 'space' send the ID; 'space_name'
// sends the space's name, which is what the block-tags form looks up. The
// block-tags form also picks a template and a site by name, and a block by its
// address ('block_addr', sent as address and cidr).
const TAGS_HINT = 'Each tag is a name and a value, like env=prod. Separate tags with commas.'
const FIELD_SPECS = {
  dns_zone: {
    label: 'DNS zone', endpoint: '/api/edit/dns_zone', fields: [
      { key: 'fqdn', label: 'Zone name', kind: 'text', placeholder: 'e.g. zone.example.com.', required: true },
      { key: 'view', label: 'DNS view', kind: 'view', required: true },
      { key: 'comment', label: 'Comment', kind: 'text' },
      { key: 'tags', label: 'Tags', kind: 'text', placeholder: 'e.g. env=prod, team=noc', hint: TAGS_HINT },
    ],
  },
  subnet: {
    label: 'Subnet', endpoint: '/api/edit/subnet', fields: [
      // The IP space only narrows the block list (listOnly: never sent). Two
      // blocks can share an address in different spaces, and the block list
      // does not say which space each is in, so blocks are picked within one.
      { key: 'block_space', label: 'IP space', kind: 'space', required: true, listOnly: true },
      { key: 'block_id', label: 'Address block', kind: 'block', required: true },
      { key: 'cidr', label: 'How many devices need an address?', kind: 'devices', required: true },
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'comment', label: 'Comment', kind: 'text' },
      { key: 'tags', label: 'Tags', kind: 'text', hint: TAGS_HINT },
    ],
  },
  address_block: {
    label: 'Address block', endpoint: '/api/edit/address_block', fields: [
      { key: 'address', label: 'Address', kind: 'text', placeholder: 'e.g. 10.20.0.0', required: true },
      { key: 'cidr', label: 'How many devices need an address?', kind: 'devices', required: true },
      { key: 'space', label: 'IP space', kind: 'space', required: true },
      { key: 'comment', label: 'Comment', kind: 'text' },
      { key: 'tags', label: 'Tags', kind: 'text', hint: TAGS_HINT },
    ],
  },
  dhcp_range: {
    label: 'DHCP range', endpoint: '/api/edit/dhcp_range', fields: [
      { key: 'start', label: 'Start address', kind: 'text', placeholder: 'e.g. 10.20.0.100', required: true },
      { key: 'end', label: 'End address', kind: 'text', placeholder: 'e.g. 10.20.0.200', required: true },
      { key: 'space', label: 'IP space', kind: 'space', required: true },
      { key: 'tags', label: 'Tags', kind: 'text', hint: TAGS_HINT },
    ],
  },
  host: {
    label: 'Host', endpoint: '/api/edit/host', fields: [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. host.example.com', required: true },
      { key: 'addresses', label: 'Addresses (comma-separated)', kind: 'text', placeholder: 'e.g. 10.0.0.5, 10.0.0.6', required: true },
      { key: 'comment', label: 'Comment', kind: 'text' },
    ],
  },
  tags: {
    label: 'Tags on address blocks', endpoint: '/api/retag/block', fields: [
      // The IP space comes first: the sites and blocks listed are that space's.
      { key: 'ip_space', label: 'IP space', kind: 'space_name' },
      { key: 'template', label: 'Site template', kind: 'template' },
      { key: 'site', label: 'Site', kind: 'site' },
      { key: 'address', label: 'Address block', kind: 'block_addr' },
      { key: 'status', label: 'Status', kind: 'text', placeholder: 'e.g. available' },
    ],
  },
}

const EDITOR_TYPES = [
  { key: 'dns_zone', label: 'DNS zone' },
  { key: 'subnet', label: 'Subnet' },
  { key: 'address_block', label: 'Address block' },
  { key: 'dhcp_range', label: 'DHCP range' },
  { key: 'host', label: 'Host' },
  { key: 'tags', label: 'Tags' },
]

// "DNS zone" stays "DNS zone", "Address block" reads "address block": lower
// case except acronyms, for use inside a sentence.
const nounOf = (label) => label.split(' ').map((w) => (w === w.toUpperCase() ? w : w.toLowerCase())).join(' ')

const PICK_WORDS = { view: 'DNS views', block: 'address blocks', space: 'IP spaces', space_name: 'IP spaces', template: 'site templates', site: 'sites', block_addr: 'address blocks' }
const PICK_ONE = { view: 'a DNS view', block: 'an address block', space: 'an IP space', space_name: 'an IP space', template: 'a site template', site: 'a site', block_addr: 'an address block' }

// A list picker for one ID field. A value the list does not hold (the list
// failed, or an item from a search) stays shown as itself, never dropped.
function PickField({ f, value, onChange, api, options, error, disabled, title, optional, placeholder }) {
  const lid = `ed-l-${f.key}`
  const eid = `ed-missing-${f.key}`
  const opts = value && !options.some((o) => o.value === value) ? [...options, { value, label: value }] : options
  // An empty required pick is marked on the list itself, as a typed box is:
  // aria-invalid (which also draws the red outline) and a link to the reason.
  // FilterSelect takes no such props, so they are set on its list here.
  const ref = useRef(null)
  useEffect(() => {
    const sel = ref.current?.querySelector('select')
    if (!sel) return
    if (error) { sel.setAttribute('aria-invalid', 'true'); sel.setAttribute('aria-describedby', eid) }
    else { sel.removeAttribute('aria-invalid'); sel.removeAttribute('aria-describedby') }
  }, [error, eid])
  return (
    <div ref={ref} data-field="" data-field-key={f.key} role="group" aria-labelledby={lid} title={title}
      className="text-note text-muted flex flex-col gap-1">
      <span id={lid}>{f.label}{optional ? ' (optional)' : ''}</span>
      <div className="flex flex-col gap-1">
        <FilterSelect label={f.label} value={value} onChange={onChange} options={opts} disabled={disabled}
          placeholder={placeholder || (api.loading ? 'Loading…' : `Pick ${PICK_ONE[f.kind]}`)} />
        {error && <FieldError id={eid}>{error}</FieldError>}
        <FetchError error={api.error} stale={options.length > 0} what={PICK_WORDS[f.kind]} />
      </div>
    </div>
  )
}

const EDIT_UPDATE_TYPES = ['dns_zone', 'subnet', 'dhcp_range', 'host']

// Fields Infoblox won't change on an existing item through this form (the
// server's update ignores them), so they are read-only while updating.
const UPDATE_FIXED = { dns_zone: ['fqdn', 'view'], subnet: ['block_space', 'block_id', 'cidr'], dhcp_range: ['space'] }

// What each type's search actually matches; Infoblox refuses a partial match
// on subnet and range addresses, so those take a full IP.
const FIND_HINT = {
  dns_zone: 'Find by zone name or comment',
  subnet: 'Find by name, comment or full network address',
  address_block: 'Find by address or comment',
  dhcp_range: 'Find by comment, or a full start or end IP',
  host: 'Find by name or comment',
}
const EDIT_DELETE_TYPES = ['dns_zone', 'subnet', 'dhcp_range', 'host', 'address_block']

function hashParams() {
  const hash = window.location.hash || ''
  const q = hash.split('?')[1] || ''
  return Object.fromEntries(new URLSearchParams(q))
}

function parseTags(str) {
  const out = {}
  String(str || '').split(',').forEach((pair) => {
    const i = pair.indexOf('=')
    if (i < 0) return
    const k = pair.slice(0, i).trim()
    if (k) out[k] = pair.slice(i + 1).trim()
  })
  return out
}

// A picked host carries each address's IP space ("ip=space, ..."), which the
// host update expects with every address. A kept address is sent once per
// space it had, so one IP held in two spaces keeps both. An address the host
// did not have gets the host's space when all its addresses share one.
function hostAddresses(raw, spaces) {
  const known = String(spaces || '').split(',').map((p) => p.trim().split('=')).filter(([a, sp]) => a && sp)
  const all = [...new Set(known.map(([, sp]) => sp))]
  const typed = [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))]
  return typed.flatMap((a) => {
    const had = known.filter(([ip]) => ip === a).map(([, space]) => ({ address: a, space }))
    if (had.length) return had
    return all.length === 1 ? [{ address: a, space: all[0] }] : [{ address: a }]
  })
}

// Find an existing item by name, address or comment, instead of pasting its ID.
// A deep link (#editor?type=&id=&q=) passes initialQ and pickId: the box starts
// with q typed in, and when that search answers, the item with that id is
// picked as if clicked. No such item: the results stay up and nothing is picked.
function FindExisting({ type, label, picked, busy, onPick, onClear, initialQ = '', pickId = '' }) {
  const [text, setText] = useState(initialQ)
  const [state, setState] = useState({ q: '', items: null, error: null })
  // The deep link's pick happens once, and only on the search it asked for.
  const autoPick = useRef(pickId)
  useEffect(() => {
    const q = text.trim()
    if (!q) { setState({ q: '', items: null, error: null }); return }
    let live = true
    // The deep link's own search asks for its item by id, because q alone can
    // match more than the 25 find returns. No such item: the plain q search.
    const byId = autoPick.current && q === initialQ.trim() ? autoPick.current : ''
    const get = (itemId) =>
      fetch(`/api/edit/${type}/find?q=${encodeURIComponent(q)}${itemId ? `&id=${encodeURIComponent(itemId)}` : ''}`)
        .then(async (r) => {
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.error) throw new Error(j.error || failureText(r.status, 'find that item'))
          return j.items ?? []
        })
    const id = setTimeout(() => {
      get(byId)
        .then((items) => (byId && items.length === 0 ? get('') : items))
        .then((items) => { if (live) setState({ q, items, error: null }) })
        .catch((e) => { if (live) setState({ q, items: null, error: String(e?.message || e) }) })
    }, 300)
    return () => { live = false; clearTimeout(id) }
  }, [text, type, initialQ])
  // Results for an older search are hidden until the current one answers, so
  // a click cannot pick an item the box no longer asks for.
  const fresh = state.items && state.q === text.trim()
  useEffect(() => {
    if (!autoPick.current || state.q !== initialQ.trim() || (!state.items && !state.error)) return
    const it = state.items?.find((x) => x.id === autoPick.current)
    autoPick.current = ''
    if (it) onPick(it)
  }, [state, initialQ, onPick])
  const noun = nounOf(label)
  const seen = {}
  ;(fresh ? state.items : []).forEach((it) => { seen[it.label] = (seen[it.label] || 0) + 1 })

  return (
    <div className="flex flex-col gap-1">
      <label className="text-note text-muted flex flex-col gap-1">
        <span>Change or delete an existing {noun}</span>
        <input
          {...MACHINE_TEXT}
          type="search"
          className={inputCls}
          value={text}
          placeholder={FIND_HINT[type]}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {state.error && <div className="text-note" style={{ color: COLORS.crit }}>Couldn't search: {state.error}</div>}
      {fresh && state.items.length === 0 && <div className="text-note text-muted">Nothing matches “{state.q}”.</div>}
      {fresh && state.items.length > 0 && (
        <ul aria-label={`Matching ${noun} items`} className="flex flex-col gap-1 max-h-56 overflow-y-auto">
          {state.items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                aria-pressed={picked === it.id}
                // Not while a Preview or Apply is running: its answer belongs
                // to the item that was picked when it was sent.
                disabled={busy}
                onClick={() => onPick(it)}
                className="w-full text-left text-copy px-2.5 py-1.5 rounded-control border border-border hover:border-border-hover"
                style={picked === it.id ? { borderColor: COLORS.accent } : undefined}
              >
                {/* Two items with the same label (one subnet in two IP spaces) get their ID too. */}
                {seen[it.label] > 1 || !it.label ? `${it.label || ''} ${it.id}`.trim() : it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked && (
        <button type="button" onClick={onClear} disabled={busy} className="self-start text-note text-link underline disabled:opacity-40">
          Make a new one instead
        </button>
      )}
    </div>
  )
}

export default function Editor() {
  const ro = useReadOnly()
  const params = hashParams()
  const initialType = EDITOR_TYPES.some((t) => t.key === params.type) ? params.type : 'dns_zone'

  const [type, setType] = useState(initialType)
  // #editor?type=&id=&q= from another page (Network's Overlapping ranges):
  // search for q and pick id, exactly as typing q and clicking the item would.
  // Until that search answers nothing is picked, so an id that does not come
  // back leaves nothing picked. Dropped once the person picks another type.
  const [deep, setDeep] = useState(() => (params.q ? { type: initialType, q: params.q, id: params.id || '' } : null))
  const [editId, setEditId] = useState(params.q ? '' : params.id || '')
  // The values an item had when it was picked from Find. Update then sends
  // only what was changed, so it never overwrites someone else's newer edit
  // to a field this person didn't touch.
  const [loaded, setLoaded] = useState(null)
  const [fields, setFields] = useState({})
  const [status, setStatus] = useState('idle') // idle | busy | previewed | applied
  const [stale, setStale] = useState(false)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null) // { ok, msg }
  // The required field Preview or Create found empty: marked, explained under
  // it, and given the cursor, so the person is not sent hunting for it.
  const [missingKey, setMissingKey] = useState(null)
  const formRef = useRef(null)
  const [missingTick, setMissingTick] = useState(0)
  useEffect(() => {
    // A picker's list, not its search box, is the field; a typed box is its input.
    const row = missingKey && formRef.current?.querySelector(`[data-field-key="${missingKey}"]`)
    if (row) (row.querySelector('select:not(:disabled)') ?? row.querySelector('input:not(:disabled)'))?.focus()
  }, [missingKey, missingTick])

  // Re-seed the form whenever the type changes so deep-link params prefill it.
  useEffect(() => {
    const spec = FIELD_SPECS[type]
    const seed = {}
    if (spec) spec.fields.forEach((f) => { if (params[f.key] != null) seed[f.key] = params[f.key] })
    setFields(seed)
    setPreview(null)
    setStatus('idle')
    setStale(false)
    setResult(null)
    setMissingKey(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  // #editor?type=dhcp_range&subnet=…&network=…, from a network's Add a DHCP
  // range: the range goes in that network's IP space, which Infoblox wants as
  // an id. A table row knows the network but not its space, so the network is
  // looked up (the same read its own page makes) and the space filled in.
  // It follows the hash, so a second network's link while the Editor is open
  // replaces the space the first lookup filled in, but never one typed by hand.
  const live = useHashParams()
  const rangeOn = live.type === 'dhcp_range'
  const rangeNet = rangeOn ? live.network || '' : ''
  const rangeLookup = useNetworkPrefill(rangeOn && !live.space ? { subnet: live.subnet, network: live.network } : {})
  const rangeFilled = useRef('')
  useEffect(() => {
    if (type !== 'dhcp_range' || rangeLookup.pending || !rangeLookup.space) return
    const was = rangeFilled.current
    rangeFilled.current = rangeLookup.space
    setFields((prev) => (prev.space && prev.space !== was ? prev : { ...prev, space: rangeLookup.space }))
    setMissingKey((k) => (k === 'space' ? null : k))
  }, [type, rangeLookup.pending, rangeLookup.space])
  const rangeSpaceMissed = type === 'dhcp_range' && rangeOn && !!(live.subnet || live.network) && !live.space &&
    !rangeLookup.pending && !rangeLookup.space && !fields.space

  const spec = FIELD_SPECS[type]
  // Each list is read only while a form that needs it is open.
  const needs = (kind) => !!spec?.fields.some((f) => f.kind === kind)
  const viewsApi = useApi(needs('view') ? '/api/dns/zones' : null, SHARE_PICKER)
  // A new subnet's blocks come from the IP space picked above them. An existing
  // subnet's block cannot change, so all blocks are read only to name it.
  const isUpdate = !!editId.trim() && EDIT_UPDATE_TYPES.includes(type)
  const blockSpace = fields.block_space || ''
  const blocksApi = useApi(!needs('block') ? null
    : blockSpace ? `/api/ipam/blocks?space=${encodeURIComponent(blockSpace)}`
    : isUpdate ? '/api/ipam/blocks' : null)
  const spacesApi = useApi(needs('space') || needs('space_name') ? '/api/ipam/spaces' : null, SHARE_PICKER)
  // The block-tags form: templates as Provision and Compare to template read
  // them, and the picked IP space's blocks, for their addresses and the sites
  // tagged on them. Only that space's: two spaces can hold the same address,
  // and the server looks the block up by address within the space it is sent.
  const templatesApi = useApi(needs('template') ? '/api/templates' : null, SHARE_PICKER)
  const tagSpaceId = (spacesApi.data?.spaces ?? []).find((sp) => sp.name && sp.name === fields.ip_space)?.id || ''
  const allBlocksApi = useApi((needs('site') || needs('block_addr')) && tagSpaceId
    ? `/api/ipam/blocks?space=${encodeURIComponent(tagSpaceId)}` : null)
  const allBlocks = tagSpaceId ? allBlocksApi.data?.blocks ?? [] : []
  // While the space's blocks load, or after that load fails, the list may
  // still hold another space's, so it cannot be picked from.
  const tagListOff = !tagSpaceId || allBlocksApi.loading || !!allBlocksApi.error
  const pickOptions = {
    view: (viewsApi.data?.views ?? []).map((v) => ({ value: v.id, label: v.name || v.id })),
    block: (blocksApi.data?.blocks ?? []).map((b) => ({
      value: b.id,
      label: b.address ? `${withSize(`${b.address}${b.cidr ? `/${b.cidr}` : ''}`)}${b.name ? ` — ${b.name}` : ''}` : b.name || b.id,
    })),
    space: (spacesApi.data?.spaces ?? []).map((sp) => ({ value: sp.id, label: sp.name || sp.id })),
    space_name: (spacesApi.data?.spaces ?? []).filter((sp) => sp.name).map((sp) => ({ value: sp.name, label: sp.name })),
    template: (Array.isArray(templatesApi.data) ? templatesApi.data : [])
      .filter((t) => t.name && (!t.type || t.type === 'site')).map((t) => ({ value: t.name, label: t.name })),
    site: [...new Set(allBlocks.map((b) => b.tags?.Site).filter((v) => v && v !== 'unassigned'))].sort()
      .map((v) => ({ value: v, label: v })),
    block_addr: allBlocks.filter((b) => b.address && b.cidr).map((b) => ({
      value: `${b.address}/${b.cidr}`,
      label: `${withSize(`${b.address}/${b.cidr}`)}${b.name ? ` — ${b.name}` : ''}`,
    })),
  }
  const pickApi = { view: viewsApi, block: blocksApi, space: spacesApi, space_name: spacesApi, template: templatesApi, site: allBlocksApi, block_addr: allBlocksApi }
  // Preview stays grey, with a hint naming each empty required box, until a
  // new one can be sent (as on Get an address). A list that failed to load
  // says to load it, since there is nothing to pick.
  const needWord = (f) => {
    if (f.kind in PICK_ONE) {
      return pickApi[f.kind]?.error && !pickOptions[f.kind].length ? `load the ${PICK_WORDS[f.kind]}` : `pick ${PICK_ONE[f.kind]}`
    }
    if (f.kind === 'devices') return 'enter how many devices need an address'
    return `fill in the ${nounOf(f.label.replace(/\s*\(.*\)$/, ''))}`
  }
  const previewNeeds = !spec || isUpdate ? [] : [...new Set(spec.fields
    .filter((f) => f.required && !String(fields[f.key] || '').trim()).map(needWord))]
  // Forms with a required field mark the others "(optional)", as Get an address does.
  const anyRequired = !!spec?.fields.some((f) => f.required)
  const canDelete = !!editId.trim() && EDIT_DELETE_TYPES.includes(type)
  const isV6 = String(fields.address || '').includes(':')

  // Any input edit invalidates a preview taken before it — Apply must never
  // submit a body the user has not seen.
  // Edits made while Preview is loading count too.
  const editedWhileBusy = useRef(false)
  function markStale() {
    if (status === 'previewed') setStale(true)
    if (status === 'busy') editedWhileBusy.current = true
  }

  function setField(k, v) {
    setFields((prev) => ({ ...prev, [k]: v }))
    if (k === missingKey) setMissingKey(null)
    markStale()
  }

  function buildBody() {
    const body = {}
    spec.fields.forEach((f) => {
      const raw = fields[f.key]
      if (isUpdate && loaded) {
        if (String(raw ?? '') === String(loaded[f.key] ?? '')) return
        // A field emptied on purpose is sent empty, which clears it.
        if (raw == null || raw === '') { body[f.key] = f.key === 'tags' ? {} : ''; return }
      } else if (raw == null || raw === '') return
      if (f.listOnly) return
      if (f.key === 'tags') body.tags = parseTags(raw)
      else if (f.key === 'addresses') body.addresses = hostAddresses(raw, fields.spaces)
      else if (f.kind === 'block_addr') {
        const cut = String(raw).lastIndexOf('/')
        body.address = String(raw).slice(0, cut)
        body.cidr = Number(String(raw).slice(cut + 1))
      }
      else if (f.kind === 'devices') body[f.key] = Number(raw)
      else body[f.key] = raw
    })
    return body
  }

  async function doFetch(url, method, body) {
    try {
      const res = await tokenFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => null)
      return { ok: res.ok, status: res.status, data }
    } catch {
      return { ok: false, status: 0, data: null }
    }
  }

  function send(dry) {
    if (!spec || status === 'busy') return
    if (!isUpdate) {
      const missing = spec.fields.find((f) => f.required && !String(fields[f.key] || '').trim())
      if (missing) {
        setResult(null)
        setMissingKey(missing.key)
        setMissingTick((n) => n + 1)
        return
      }
    }
    setMissingKey(null)
    const body = buildBody()
    const sent = fields
    body.dry = dry
    const method = isUpdate ? 'PATCH' : 'POST'
    const url = isUpdate ? `${spec.endpoint}/${encodeURIComponent(editId.trim())}` : spec.endpoint

    editedWhileBusy.current = false
    setStatus('busy')
    setResult(null)

    doFetch(url, method, body).then(({ ok, status: code, data }) => {
      const j = data || {}
      if (!ok || j.error || j.ok === false || (!dry && !data)) {
        setResult({ ok: false, msg: dry ? j.error || 'request failed' : writeFailureText(code, data, 'complete this change') })
        setPreview(null)
        setStatus('idle')
        return
      }
      if (dry) {
        setPreview(j)
        setStale(editedWhileBusy.current)
        setStatus('previewed')
        setResult({ ok: true, msg: `Preview only — nothing has been ${isUpdate ? 'changed' : 'created'}. Review it, then ${isUpdate ? 'Update' : 'Create'}.` })
      } else {
        setPreview(null)
        setStale(false)
        setStatus('applied')
        setResult({ ok: true, msg: j.message || `${spec.label} ${isUpdate ? 'updated' : 'created'}.` })
        if (!isUpdate) setFields({})
        // The item now holds what was sent, so the next Update sends only
        // what changes after this one.
        else if (loaded) setLoaded(sent)
      }
    })
  }

  // A separate confirm box instead of window.confirm — blocking dialogs freeze
  // browser automation. The Delete button only opens and closes the box.
  const [delArmed, setDelArmed] = useState(false)
  const [delSay, setDelSay] = useState('')
  const delConfirmRef = useRef('')
  // A Delete armed for one item must never fire on another.
  // That includes a check still running: its answer is about the old item.
  const delCheckRef = useRef(0)
  function disarmDelete() {
    delCheckRef.current += 1
    setDelArmed(false)
  }
  function del() {
    if (!spec || !editId.trim() || status === 'busy') return
    if (delArmed) { disarmDelete(); return }
    const id = editId.trim()
    // Kinds Made with Bloxsmith deletes go through it, so the one "are you
    // sure" says whether Bloxsmith made the item and the delete is recorded.
    if (!madeKind(type)) { setDelSay(''); setDelArmed(true); return }
    setResult(null)
    const run = ++delCheckRef.current
    checkDelete(type, id).then((c) => {
      if (run !== delCheckRef.current) return
      if (!c.ok || c.data?.blocked || c.data?.gone) {
        setResult({ ok: false, msg: c.data?.blocked || (c.data?.gone ? 'That item is already gone.' : c.data?.error || 'could not check it, so nothing was deleted') })
        return
      }
      delConfirmRef.current = c.data.confirm
      setDelSay(whoMade(c.data))
      setDelArmed(true)
    })
  }
  function confirmDel() {
    if (!spec || !editId.trim() || status === 'busy') return
    const id = editId.trim()
    const tracked = madeKind(type)
    setDelArmed(false)
    setStatus('busy')
    setResult(null)
    const sent = tracked
      ? confirmDelete(type, id, delConfirmRef.current)
      : tokenFetch(`${spec.endpoint}/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => null) }))
    sent
      .catch(() => ({ ok: false, status: 0, data: null }))
      .then(({ ok, status: code, data }) => {
        const j = data || {}
        if (!ok || !data || j.error || j.ok === false) {
          setResult({ ok: false, msg: writeFailureText(code, data, 'delete this item') })
          setStatus('idle')
          return
        }
        setResult({ ok: true, msg: deletedMsg(j, spec.label) })
        setEditId('')
        setLoaded(null)
        setFields({})
        setPreview(null)
        setStale(false)
        setStatus('applied')
      })
  }

  const previewBody = preview ? (preview.would_create || preview.would_update || preview) : null

  return (
    <div className="w-full px-6 py-5">
      <PageTitle className="mb-1">Editor</PageTitle>
      <TabIntro>Make, change or delete one DNS or DHCP item at a time.</TabIntro>
      <ReadOnlyNote ro={ro} what="Preview works, because it changes nothing. Apply and Delete are off." />

      <div className="flex flex-wrap gap-1.5 mb-4">
        {EDITOR_TYPES.map((t) => (
          <button
            key={t.key}
            onClick={() => { disarmDelete(); setType(t.key); setEditId(''); setLoaded(null); setDeep(null) }}
            // Not mid-request: the answer would land on the new type's form.
            disabled={status === 'busy'}
            className={`px-2.5 py-1.5 rounded-control border text-copy disabled:opacity-50 pick${type === t.key ? ' pick-on' : ''}`}
            style={type === t.key
              ? { borderColor: COLORS.accent, background: 'var(--color-line-2)', color: 'var(--color-txt)' }
              : { borderColor: 'var(--color-border)', background: 'var(--color-field)', color: 'var(--color-field-txt)' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Inputs on the left, the preview and the button that applies it on the
          right (owner, 2026-11-11). Below lg they stack, form first. */}
      {spec ? <FormColumns form={
        <section aria-labelledby="editor-form-h" data-editor-form="" ref={formRef}>
        <ColumnHeading id="editor-form-h">{type === 'tags' ? 'Change the tags on address blocks' : isUpdate ? `Change this ${nounOf(spec.label)}` : `New ${nounOf(spec.label)}`}</ColumnHeading>
        <div data-form-cols="" className="flex flex-col gap-3">
          {EDIT_DELETE_TYPES.includes(type) && (
            <FindExisting
              key={type}
              type={type}
              label={spec.label}
              picked={editId}
              busy={status === 'busy'}
              initialQ={deep?.type === type ? deep.q : ''}
              pickId={deep?.type === type ? deep.id : ''}
              onPick={(item) => {
                disarmDelete()
                setPreview(null); setStale(false); setStatus('idle'); setResult(null); setMissingKey(null)
                // Delete-only types (address blocks) just need the ID; filling
                // the form would only set up an accidental second Create.
                if (!EDIT_UPDATE_TYPES.includes(type)) { setEditId(item.id); setLoaded(null); return }
                const f = Object.fromEntries(Object.entries(item.fields).map(([k, v]) => [k, v == null ? '' : String(v)]))
                setEditId(item.id)
                setFields(f)
                setLoaded(f)
              }}
              onClear={() => {
                disarmDelete()
                setEditId(''); setFields({}); setLoaded(null)
                setPreview(null); setStale(false); setStatus('idle'); setResult(null); setMissingKey(null)
              }}
            />
          )}

          {type === 'dhcp_range' && rangeNet && <p className="text-note text-muted">For network {rangeNet}.</p>}
          {rangeSpaceMissed && (
            <p role="status" className="text-note" style={{ color: COLORS.warn }}>
              The IP space of {rangeNet || 'this network'} could not be filled in. Pick it from the list.
            </p>
          )}
          {spec.fields.map((f) => (f.kind in PICK_WORDS ? (
            <PickField key={`${type}-${f.key}`} f={f} value={fields[f.key] || ''}
              onChange={(v) => {
                setField(f.key, v)
                // A block from the old space is not in the new one.
                if (f.key === 'block_space') setFields((prev) => ({ ...prev, block_id: '' }))
                if (type === 'tags' && f.key === 'ip_space') setFields((prev) => ({ ...prev, site: '', address: '' }))
              }}
              api={pickApi[f.kind]} options={pickOptions[f.kind]} optional={anyRequired && !f.required}
              error={missingKey === f.key ? MISSING : ''}
              // While a new space's blocks load, or after that load fails, the
              // list may still hold the old space's blocks, so it cannot be picked from.
              placeholder={(f.kind === 'block' && !isUpdate && !blockSpace) || ((f.kind === 'site' || f.kind === 'block_addr') && !tagSpaceId)
                ? 'Pick an IP space first' : undefined}
              disabled={(isUpdate && (UPDATE_FIXED[type] || []).includes(f.key)) ||
                (f.kind === 'block' && !isUpdate && (!blockSpace || blocksApi.loading || !!blocksApi.error)) ||
                ((f.kind === 'site' || f.kind === 'block_addr') && tagListOff)}
              title={isUpdate && (UPDATE_FIXED[type] || []).includes(f.key) ? "Can't be changed on an existing one" : undefined} />
          ) : f.kind === 'devices' && !isUpdate && !isV6 ? (
            // A device count is only for making a new IPv4 network. It is a
            // form row of its own (data-field), so it lines up with the others.
            <DevicesInput key={`${type}-${f.key}`} data-field-key={f.key} label={f.label} prefix={fields[f.key] ?? ''}
              onPrefix={(p) => setField(f.key, p)} error={missingKey === f.key ? MISSING : ''} />
          ) : f.kind === 'devices' ? (
            // A size that names an existing one, or an IPv6 size, is typed
            // exactly. Its label sits above the box, in line with the boxes.
            <div key={`${type}-${f.key}`} data-field-key={f.key}>
              <PrefixInput label={`Size: the number after the slash${anyRequired && !f.required ? ' (optional)' : ''}`}
                prefix={fields[f.key] ?? ''} family={isV6 ? 6 : 4}
                onPrefix={(p) => setField(f.key, p)} error={missingKey === f.key ? MISSING : ''}
                disabled={isUpdate && (UPDATE_FIXED[type] || []).includes(f.key)}
                title={isUpdate && (UPDATE_FIXED[type] || []).includes(f.key) ? "Can't be changed on an existing one" : undefined} />
            </div>
          ) : (
            <label key={f.key} data-field="" data-field-key={f.key} className="text-note text-muted flex flex-col gap-1">
              <span>{f.label}{anyRequired && !f.required ? ' (optional)' : ''}</span>
              <input {...(f.key === 'comment' ? null : MACHINE_TEXT)}
                className={`${inputCls} disabled:opacity-60`}
                disabled={isUpdate && (UPDATE_FIXED[type] || []).includes(f.key)}
                title={isUpdate && (UPDATE_FIXED[type] || []).includes(f.key) ? "Can't be changed on an existing one" : undefined}
                type={f.kind === 'number' ? 'number' : 'text'}
                value={fields[f.key] || ''}
                placeholder={f.placeholder || ''}
                onChange={(e) => setField(f.key, e.target.value)}
                aria-invalid={missingKey === f.key || undefined}
                aria-describedby={missingKey === f.key ? `ed-missing-${f.key}` : undefined}
              />
              {/* Inside the label, so it is read with the field's name. */}
              {f.hint && <span className="text-note text-dim">{f.hint}</span>}
              {missingKey === f.key && <FieldError id={`ed-missing-${f.key}`}>{MISSING}</FieldError>}
            </label>
          )))}

          <PreviewApply
            part="start"
            status={status}
            stale={stale}
            disabled={previewNeeds.length > 0}
            needs={previewNeeds}
            onPreview={() => send(true)}
            onApply={() => send(false)}
            applyLabel={isUpdate ? 'Update' : 'Create'}
            error={result && !result.ok ? result.msg : null}
            message={result && result.ok ? result.msg : null}
          />

          {canDelete && (
            <div className="flex pt-1 border-t border-border">
              <button
                onClick={del}
                disabled={status === 'busy'}
                aria-expanded={delArmed}
                className="mt-3 px-3 py-1.5 rounded-control text-copy border ml-auto disabled:opacity-50"
                style={{ borderColor: COLORS.crit, color: COLORS.crit, background: 'transparent' }}
              >
                {`Delete ${spec.label}`}
              </button>
            </div>
          )}
          {canDelete && delArmed && (
            <ConfirmStep warn takeFocus yesLabel="Permanently delete" yesDisabled={status === 'busy'} onYes={confirmDel} onCancel={disarmDelete}>
              {delSay || `This permanently deletes this ${spec.label}.`}
            </ConfirmStep>
          )}
        </div>
        </section>
      } result={
        <section aria-labelledby="editor-result-h" data-editor-result="">
          <ColumnHeading id="editor-result-h">Preview</ColumnHeading>
          <PreviewApply
            part="outcome"
            status={status}
            stale={stale}
            disabled={previewNeeds.length > 0}
            needs={previewNeeds}
            onPreview={() => send(true)}
            onApply={() => send(false)}
            applyLabel={isUpdate ? 'Update' : 'Create'}
            error={result && !result.ok ? result.msg : null}
            message={result && result.ok ? result.msg : null}
          >
            {previewBody
              ? <><PreviewBox data={previewBody} note={`preview — nothing has been ${isUpdate ? 'changed' : 'created'} yet`} /><CheckedAgainst res={preview} /></>
              : !result && <p className="text-copy text-muted">Press Preview to see what would be sent. Nothing changes in Infoblox until you press {isUpdate ? 'Update' : 'Create'}.</p>}
          </PreviewApply>
        </section>
      } /> : <Empty>unknown type</Empty>}
      <section className="mt-8" aria-labelledby="editor-made-h">
        <ColumnHeading id="editor-made-h">Made here</ColumnHeading>
        <p className="text-note text-muted mb-2">Made in the Editor, newest first. Each delete asks first.</p>
        <MadeList sources={['editor']} ro={ro.readOnly} empty="Nothing made here yet." />
      </section>
    </div>
  )
}
