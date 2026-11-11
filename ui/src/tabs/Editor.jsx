import { useEffect, useRef, useState } from 'react'
import { ColumnHeading, FormColumns, ReadOnlyNote } from '../components/kit.jsx'
import { COLORS, deletedMsg, Empty, FIELD_CLS, PreviewApply, PreviewBox, TabIntro } from '../components/ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { tokenFetch } from '../lib/authFetch.js'

const inputCls = `${FIELD_CLS} w-full`

const FIELD_SPECS = {
  dns_zone: {
    label: 'DNS Zone', endpoint: '/api/edit/dns_zone', fields: [
      { key: 'fqdn', label: 'Zone name', kind: 'text', placeholder: 'zone.example.com.', required: true },
      { key: 'view', label: 'DNS view ID', kind: 'text', placeholder: 'view id', required: true },
      { key: 'comment', label: 'Comment', kind: 'text' },
      { key: 'tags', label: 'Tags (key=value, key2=value2)', kind: 'text', placeholder: 'env=prod,team=noc' },
    ],
  },
  subnet: {
    label: 'Subnet', endpoint: '/api/edit/subnet', fields: [
      { key: 'block_id', label: 'Address block ID', kind: 'text', placeholder: 'block id', required: true },
      { key: 'cidr', label: 'Size (prefix: 24 = 256 addresses)', kind: 'number', placeholder: '24', required: true },
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'comment', label: 'Comment', kind: 'text' },
      { key: 'tags', label: 'Tags (key=value, key2=value2)', kind: 'text' },
    ],
  },
  address_block: {
    label: 'Address Block', endpoint: '/api/edit/address_block', fields: [
      { key: 'address', label: 'Address', kind: 'text', placeholder: '10.20.0.0', required: true },
      { key: 'cidr', label: 'Size (prefix: 24 = 256 addresses)', kind: 'number', placeholder: '16', required: true },
      { key: 'space', label: 'IP Space', kind: 'text', placeholder: 'my-ip-space', required: true },
      { key: 'comment', label: 'Comment', kind: 'text' },
      { key: 'tags', label: 'Tags (key=value, key2=value2)', kind: 'text' },
    ],
  },
  dhcp_range: {
    label: 'DHCP Range', endpoint: '/api/edit/dhcp_range', fields: [
      { key: 'start', label: 'Start address', kind: 'text', placeholder: '10.20.0.100', required: true },
      { key: 'end', label: 'End address', kind: 'text', placeholder: '10.20.0.200', required: true },
      { key: 'space', label: 'IP Space', kind: 'text', placeholder: 'my-ip-space', required: true },
      { key: 'tags', label: 'Tags (key=value, key2=value2)', kind: 'text' },
    ],
  },
  host: {
    label: 'Host', endpoint: '/api/edit/host', fields: [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'host.example.com', required: true },
      { key: 'addresses', label: 'Addresses (comma-separated)', kind: 'text', placeholder: '10.0.0.5, 10.0.0.6', required: true },
      { key: 'comment', label: 'Comment', kind: 'text' },
    ],
  },
  tags: {
    label: 'Tags (block re-tag)', endpoint: '/api/retag/block', fields: [
      { key: 'template', label: 'Site template', kind: 'text', placeholder: 'template name' },
      { key: 'site', label: 'Site', kind: 'text', placeholder: 'site name' },
      { key: 'address', label: 'Block address', kind: 'text', placeholder: '10.20.0.0' },
      { key: 'cidr', label: 'Size (prefix: 24 = 256 addresses)', kind: 'number', placeholder: '16' },
      { key: 'status', label: 'Status', kind: 'text', placeholder: 'available' },
      { key: 'ip_space', label: 'IP Space', kind: 'text', placeholder: 'my-ip-space' },
    ],
  },
}

const EDITOR_TYPES = [
  { key: 'dns_zone', label: 'DNS Zone' },
  { key: 'subnet', label: 'Subnet' },
  { key: 'address_block', label: 'Address Block' },
  { key: 'dhcp_range', label: 'DHCP Range' },
  { key: 'host', label: 'Host' },
  { key: 'tags', label: 'Tags' },
]

const EDIT_UPDATE_TYPES = ['dns_zone', 'subnet', 'dhcp_range', 'host']

// Fields Infoblox won't change on an existing item through this form (the
// server's update ignores them), so they are read-only while updating.
const UPDATE_FIXED = { dns_zone: ['fqdn', 'view'], subnet: ['block_id', 'cidr'], dhcp_range: ['space'] }

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
function FindExisting({ type, label, picked, busy, onPick, onClear }) {
  const [text, setText] = useState('')
  const [state, setState] = useState({ q: '', items: null, error: null })
  useEffect(() => {
    const q = text.trim()
    if (!q) { setState({ q: '', items: null, error: null }); return }
    let live = true
    const id = setTimeout(() => {
      fetch(`/api/edit/${type}/find?q=${encodeURIComponent(q)}`)
        .then(async (r) => {
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`)
          if (live) setState({ q, items: j.items ?? [], error: null })
        })
        .catch((e) => { if (live) setState({ q, items: null, error: String(e?.message || e) }) })
    }, 300)
    return () => { live = false; clearTimeout(id) }
  }, [text, type])
  // Results for an older search are hidden until the current one answers, so
  // a click cannot pick an item the box no longer asks for.
  const fresh = state.items && state.q === text.trim()
  // "DNS Zone" reads "DNS zone": lower case except acronyms.
  const noun = label.split(' ').map((w) => (w === w.toUpperCase() ? w : w.toLowerCase())).join(' ')
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
  const [editId, setEditId] = useState(params.id || '')
  // The values an item had when it was picked from Find. Update then sends
  // only what was changed, so it never overwrites someone else's newer edit
  // to a field this person didn't touch.
  const [loaded, setLoaded] = useState(null)
  const [fields, setFields] = useState({})
  const [status, setStatus] = useState('idle') // idle | busy | previewed | applied
  const [stale, setStale] = useState(false)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null) // { ok, msg }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  const spec = FIELD_SPECS[type]
  const isUpdate = !!editId.trim() && EDIT_UPDATE_TYPES.includes(type)
  const canDelete = !!editId.trim() && EDIT_DELETE_TYPES.includes(type)

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
      if (f.key === 'tags') body.tags = parseTags(raw)
      else if (f.key === 'addresses') body.addresses = hostAddresses(raw, fields.spaces)
      else if (f.kind === 'number') body[f.key] = Number(raw)
      else body[f.key] = raw
    })
    return body
  }

  async function doFetch(url, method, body) {
    try {
      const res = await tokenFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, data }
    } catch {
      return { ok: false, data: { error: 'network error' } }
    }
  }

  function send(dry) {
    if (!spec || status === 'busy') return
    if (!isUpdate) {
      const missing = spec.fields.find((f) => f.required && !String(fields[f.key] || '').trim())
      if (missing) {
        setResult({ ok: false, msg: `Missing required field: ${missing.label}` })
        return
      }
    }
    const body = buildBody()
    const sent = fields
    body.dry = dry
    const method = isUpdate ? 'PATCH' : 'POST'
    const url = isUpdate ? `${spec.endpoint}/${encodeURIComponent(editId.trim())}` : spec.endpoint

    editedWhileBusy.current = false
    setStatus('busy')
    setResult(null)

    doFetch(url, method, body).then(({ ok, data }) => {
      const j = data || {}
      if (!ok || j.error || j.ok === false) {
        setResult({ ok: false, msg: j.error || 'request failed' })
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

  // Two-click arm instead of window.confirm — blocking dialogs freeze browser automation
  const [delArmed, setDelArmed] = useState(false)
  const delArmTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(delArmTimerRef.current), [])
  // A Delete armed for one item must never fire on another.
  function disarmDelete() {
    clearTimeout(delArmTimerRef.current)
    setDelArmed(false)
  }
  function del() {
    if (!spec || !editId.trim() || status === 'busy') return
    if (!delArmed) {
      setDelArmed(true)
      clearTimeout(delArmTimerRef.current)
      delArmTimerRef.current = setTimeout(() => setDelArmed(false), 4000)
      return
    }
    clearTimeout(delArmTimerRef.current)
    setDelArmed(false)
    setStatus('busy')
    setResult(null)
    tokenFetch(`${spec.endpoint}/${encodeURIComponent(editId.trim())}`, { method: 'DELETE' })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .catch(() => ({ ok: false, data: { error: 'network error' } }))
      .then(({ ok, data }) => {
        const j = data || {}
        if (!ok || j.error || j.ok === false) {
          setResult({ ok: false, msg: j.error || 'delete failed' })
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
      <h1 className="text-copy font-semibold tracking-tight mb-1">Editor</h1>
      <TabIntro>Make, change or delete one DNS or DHCP item at a time.</TabIntro>
      <ReadOnlyNote ro={ro} what="Preview works, because it changes nothing. Apply and Delete are off." />

      <div className="flex flex-wrap gap-1.5 mb-4">
        {EDITOR_TYPES.map((t) => (
          <button
            key={t.key}
            onClick={() => { setType(t.key); setEditId(''); setLoaded(null) }}
            // Not mid-request: the answer would land on the new type's form.
            disabled={status === 'busy'}
            className="px-2.5 py-1.5 rounded-control border text-copy disabled:opacity-50"
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
        <section aria-labelledby="editor-form-h" data-editor-form="">
        <ColumnHeading id="editor-form-h">{`${spec.label}${isUpdate ? ' — Update' : ' — Create'}`}</ColumnHeading>
        <div data-form-cols="" className="flex flex-col gap-3">
          {EDIT_DELETE_TYPES.includes(type) && (
            <FindExisting
              key={type}
              type={type}
              label={spec.label}
              picked={editId}
              busy={status === 'busy'}
              onPick={(item) => {
                disarmDelete()
                setPreview(null); setStale(false); setStatus('idle'); setResult(null)
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
                setPreview(null); setStale(false); setStatus('idle'); setResult(null)
              }}
            />
          )}
          <label data-field="" className="text-note text-muted flex flex-col gap-1">
            <span>ID of an existing one (leave blank to make a new one)</span>
            <input {...MACHINE_TEXT} className={inputCls} value={editId} placeholder="existing object id — enables update/delete" onChange={(e) => { disarmDelete(); setEditId(e.target.value); setLoaded(null); markStale() }} />
          </label>

          {spec.fields.map((f) => (
            <label key={f.key} data-field="" className="text-note text-muted flex flex-col gap-1">
              <span>{f.label}{f.required ? ' *' : ''}</span>
              <input {...(f.key === 'comment' ? null : MACHINE_TEXT)}
                className={`${inputCls} disabled:opacity-60`}
                disabled={isUpdate && (UPDATE_FIXED[type] || []).includes(f.key)}
                title={isUpdate && (UPDATE_FIXED[type] || []).includes(f.key) ? "Can't be changed on an existing one" : undefined}
                type={f.kind === 'number' ? 'number' : 'text'}
                value={fields[f.key] || ''}
                placeholder={f.placeholder || ''}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            </label>
          ))}

          <PreviewApply
            part="start"
            status={status}
            stale={stale}
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
                className="mt-3 px-3 py-1.5 rounded-control text-copy border ml-auto disabled:opacity-50"
                style={delArmed
                  ? { borderColor: COLORS.crit, color: COLORS.onCrit, background: COLORS.crit }
                  : { borderColor: COLORS.crit, color: COLORS.crit, background: 'transparent' }}
              >
                {delArmed ? 'Click again to permanently delete' : `Delete ${spec.label}`}
              </button>
            </div>
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
            onPreview={() => send(true)}
            onApply={() => send(false)}
            applyLabel={isUpdate ? 'Update' : 'Create'}
            error={result && !result.ok ? result.msg : null}
            message={result && result.ok ? result.msg : null}
          >
            {previewBody
              ? <PreviewBox data={previewBody} note={`preview — nothing has been ${isUpdate ? 'changed' : 'created'} yet`} />
              : !result && <p className="text-copy text-muted">Press Preview to see what would be sent. Nothing changes in Infoblox until you press {isUpdate ? 'Update' : 'Create'}.</p>}
          </PreviewApply>
        </section>
      } /> : <Empty>unknown type</Empty>}
    </div>
  )
}
