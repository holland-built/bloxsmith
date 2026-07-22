import { useEffect, useRef, useState } from 'react'
import { COLORS, Card, Empty } from '../components/ui.jsx'

const inputCls = 'w-full px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none'

const FIELD_SPECS = {
  dns_zone: {
    label: 'DNS Zone', endpoint: '/api/edit/dns_zone', fields: [
      { key: 'fqdn', label: 'FQDN', kind: 'text', placeholder: 'zone.example.com.', required: true },
      { key: 'view', label: 'View ID', kind: 'text', placeholder: 'view id', required: true },
      { key: 'comment', label: 'Comment', kind: 'text' },
      { key: 'tags', label: 'Tags (key=value, key2=value2)', kind: 'text', placeholder: 'env=prod,team=noc' },
    ],
  },
  subnet: {
    label: 'Subnet', endpoint: '/api/edit/subnet', fields: [
      { key: 'block_id', label: 'Address Block ID', kind: 'text', placeholder: 'block id', required: true },
      { key: 'cidr', label: 'CIDR (prefix length)', kind: 'number', placeholder: '24', required: true },
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'comment', label: 'Comment', kind: 'text' },
      { key: 'tags', label: 'Tags (key=value, key2=value2)', kind: 'text' },
    ],
  },
  address_block: {
    label: 'Address Block', endpoint: '/api/edit/address_block', fields: [
      { key: 'address', label: 'Address', kind: 'text', placeholder: '10.20.0.0', required: true },
      { key: 'cidr', label: 'CIDR (prefix length)', kind: 'number', placeholder: '16', required: true },
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
      { key: 'cidr', label: 'CIDR (prefix length)', kind: 'number', placeholder: '16' },
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

export default function Editor() {
  const params = hashParams()
  const initialType = EDITOR_TYPES.some((t) => t.key === params.type) ? params.type : 'dns_zone'

  const [type, setType] = useState(initialType)
  const [editId, setEditId] = useState(params.id || '')
  const [fields, setFields] = useState({})
  const [dry, setDry] = useState(true)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [pendingApply, setPendingApply] = useState(false)
  const [result, setResult] = useState(null) // { ok, msg }

  // Re-seed the form whenever the type changes so deep-link params prefill it.
  useEffect(() => {
    const spec = FIELD_SPECS[type]
    const seed = {}
    if (spec) spec.fields.forEach((f) => { if (params[f.key] != null) seed[f.key] = params[f.key] })
    setFields(seed)
    setDry(true)
    setPreview(null)
    setPendingApply(false)
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  const spec = FIELD_SPECS[type]
  const isUpdate = !!editId.trim() && EDIT_UPDATE_TYPES.includes(type)
  const canDelete = !!editId.trim() && EDIT_DELETE_TYPES.includes(type)

  function setField(k, v) {
    setFields((prev) => ({ ...prev, [k]: v }))
  }

  function buildBody() {
    const body = {}
    spec.fields.forEach((f) => {
      const raw = fields[f.key]
      if (raw == null || raw === '') return
      if (f.key === 'tags') body.tags = parseTags(raw)
      else if (f.key === 'addresses') body.addresses = String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((a) => ({ address: a }))
      else if (f.kind === 'number') body[f.key] = Number(raw)
      else body[f.key] = raw
    })
    return body
  }

  async function doFetch(url, method, body) {
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, data }
    } catch {
      return { ok: false, data: { error: 'network error' } }
    }
  }

  function submit() {
    if (!spec || busy) return
    if (!isUpdate) {
      const missing = spec.fields.find((f) => f.required && !String(fields[f.key] || '').trim())
      if (missing) {
        setResult({ ok: false, msg: `Missing required field: ${missing.label}` })
        return
      }
    }
    const body = buildBody()
    body.dry = dry
    const method = isUpdate ? 'PATCH' : 'POST'
    const url = isUpdate ? `${spec.endpoint}/${encodeURIComponent(editId.trim())}` : spec.endpoint

    setBusy(true)
    setResult(null)
    if (dry) setPreview(null)

    doFetch(url, method, body).then(({ ok, data }) => {
      setBusy(false)
      const j = data || {}
      if (!ok || j.error || j.ok === false) {
        const msg = j.error || 'request failed'
        setResult({ ok: false, msg })
        setPreview(null)
        setPendingApply(false)
        return
      }
      if (dry) {
        setPreview(j)
        setPendingApply(true)
        setResult({ ok: true, msg: 'Dry run complete — review preview, then Apply.' })
      } else {
        setResult({ ok: true, msg: j.message || `${spec.label} ${isUpdate ? 'updated' : 'created'}.` })
        setPreview(null)
        setPendingApply(false)
        if (!isUpdate) setFields({})
      }
    })
  }

  // "Apply" after a dry run — re-sends the same request with dry:false.
  function apply() {
    if (!spec || busy) return
    const body = buildBody()
    body.dry = false
    const method = isUpdate ? 'PATCH' : 'POST'
    const url = isUpdate ? `${spec.endpoint}/${encodeURIComponent(editId.trim())}` : spec.endpoint

    setBusy(true)
    setResult(null)
    doFetch(url, method, body).then(({ ok, data }) => {
      setBusy(false)
      const j = data || {}
      if (!ok || j.error || j.ok === false) {
        setResult({ ok: false, msg: j.error || 'request failed' })
        return
      }
      setResult({ ok: true, msg: j.message || `${spec.label} ${isUpdate ? 'updated' : 'created'}.` })
      setPreview(null)
      setPendingApply(false)
      if (!isUpdate) setFields({})
    })
  }

  // Two-click arm instead of window.confirm — blocking dialogs freeze browser automation
  const [delArmed, setDelArmed] = useState(false)
  const delArmTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(delArmTimerRef.current), [])
  function del() {
    if (!spec || !editId.trim() || busy) return
    if (!delArmed) {
      setDelArmed(true)
      clearTimeout(delArmTimerRef.current)
      delArmTimerRef.current = setTimeout(() => setDelArmed(false), 4000)
      return
    }
    clearTimeout(delArmTimerRef.current)
    setDelArmed(false)
    setBusy(true)
    setResult(null)
    fetch(`${spec.endpoint}/${encodeURIComponent(editId.trim())}`, { method: 'DELETE' })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .catch(() => ({ ok: false, data: { error: 'network error' } }))
      .then(({ ok, data }) => {
        setBusy(false)
        const j = data || {}
        if (!ok || j.error || j.ok === false) {
          setResult({ ok: false, msg: j.error || 'delete failed' })
          return
        }
        setResult({ ok: true, msg: `${spec.label} deleted.` })
        setEditId('')
        setFields({})
        setPreview(null)
        setPendingApply(false)
      })
  }

  const previewBody = preview ? (preview.would_create || preview.would_update || preview) : null

  return (
    <div className="max-w-[720px] mx-auto p-5">
      <h1 className="text-lg font-semibold tracking-tight mb-1">Editor</h1>
      <p className="text-xs text-muted mb-3">Directly edit DNS/DHCP records and objects. Editor-created subnets and address blocks are ad-hoc — not tracked by a site template.</p>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {EDITOR_TYPES.map((t) => (
          <button
            key={t.key}
            onClick={() => { setType(t.key); setEditId('') }}
            className="px-2.5 py-1.5 rounded-lg border text-sm"
            style={type === t.key
              ? { borderColor: COLORS.accent, background: 'var(--pill-ok-bg)', color: 'var(--pill-ok-fg)' }
              : { borderColor: 'var(--color-border)', background: 'var(--color-field)', color: 'var(--color-field-txt)' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card title={`${spec.label}${isUpdate ? ' — Update' : ' — Create'}`}>
        <div className="flex flex-col gap-3">
          <label className="text-xs text-muted flex flex-col gap-1">
            Object ID (leave blank to create new)
            <input className={inputCls} value={editId} placeholder="existing object id — enables update/delete" onChange={(e) => setEditId(e.target.value)} />
          </label>

          {spec.fields.map((f) => (
            <label key={f.key} className="text-xs text-muted flex flex-col gap-1">
              {f.label}{f.required ? ' *' : ''}
              <input
                className={inputCls}
                type={f.kind === 'number' ? 'number' : 'text'}
                value={fields[f.key] || ''}
                placeholder={f.placeholder || ''}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            </label>
          ))}

          <label className="flex items-center gap-2 text-sm text-field-txt">
            <input type="checkbox" checked={dry} onChange={(e) => { setDry(e.target.checked); setPreview(null); setPendingApply(false) }} />
            Dry-run (no changes)
          </label>

          {result && (
            <div
              className="text-sm rounded-lg px-3 py-2"
              style={result.ok
                ? { background: 'var(--pill-ok-bg)', color: 'var(--color-ok)', border: '1px solid var(--color-ok)' }
                : { background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)', border: '1px solid var(--color-crit)' }}
            >
              {result.msg}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
              style={{ background: COLORS.accent, color: '#fff' }}
            >
              {busy ? 'Working…' : dry ? 'Preview' : isUpdate ? 'Update' : 'Submit'}
            </button>
            {pendingApply && (
              <button
                onClick={apply}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: COLORS.ok, color: 'var(--pill-ok-bg)' }}
              >
                Apply
              </button>
            )}
            {canDelete && (
              <button
                onClick={del}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-sm border ml-auto disabled:opacity-50"
                style={delArmed
                  ? { borderColor: COLORS.crit, color: '#fff', background: COLORS.crit }
                  : { borderColor: COLORS.crit, color: COLORS.crit, background: 'transparent' }}
              >
                {delArmed ? 'Click again to permanently delete' : `Delete ${spec.label}`}
              </button>
            )}
          </div>
        </div>
      </Card>

      {previewBody && (
        <Card title="Preview" note="dry run — nothing applied yet" className="mt-3">
          <pre className="text-xs whitespace-pre-wrap max-h-[420px] overflow-auto text-muted">
            {JSON.stringify(previewBody, null, 2)}
          </pre>
        </Card>
      )}

      {!spec && <Empty>unknown type</Empty>}
    </div>
  )
}
