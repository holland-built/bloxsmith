// The job desk: pick a job, answer a few plain questions, check what will be
// made, Build. Every Build is recorded with the exact Infoblox IDs it made
// (go/internal/runs), so "Your recent changes" can remove exactly that.
//
// The older pages (Provision, Self-Service, Demo server) stay as they are.
// Changes made there are not recorded here and cannot be removed from here.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { authFetch } from '../lib/authFetch.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { ReadOnlyNote } from '../components/kit.jsx'
import { Card, COLORS, Empty, FetchError, FIELD_CLS, PreviewApply, TabIntro } from '../components/ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import FilterSelect from '../components/FilterSelect.jsx'

const JOBS = [
  { id: 'ip', title: 'Get an IP address', says: 'The next free address in a network you pick' },
  { id: 'dns', title: 'Add a DNS name', says: 'A name that points at an address or another name' },
  { id: 'network', title: 'Make a new network', says: 'The next free network of the size you pick' },
]

// Network sizes the Make a new network job offers, in plain words.
const SIZES = [24, 25, 26, 27, 28, 29].map((c) => ({ value: String(c), label: `/${c}, ${2 ** (32 - c)} addresses` }))

const DNS_TYPES = [
  { value: 'A', label: 'A: points at an IPv4 address', hint: '10.1.2.3' },
  { value: 'AAAA', label: 'AAAA: points at an IPv6 address', hint: '2001:db8::10' },
  { value: 'CNAME', label: 'CNAME: points at another name', hint: 'web.example.com' },
  { value: 'TXT', label: 'TXT: holds a line of text', hint: 'v=spf1 -all' },
]

const subnetLabel = (s) => (s.address || '') + (s.cidr ? `/${s.cidr}` : '') + (s.name ? `, ${s.name}` : '')

// Preview and Build for one job. Preview posts dry:true and records nothing;
// Build posts the same input with dry:false. Changing any answer clears the
// preview, so a Build always matches what was last shown.
function useDeskFlow(job, onBuilt) {
  const [status, setStatus] = useState('idle')
  const [preview, setPreview] = useState(null)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  // Bumped whenever an answer changes. A reply to an older request is dropped,
  // so a slow Preview cannot show results for answers that are no longer there.
  const gen = useRef(0)

  const reset = useCallback(() => {
    gen.current++
    setStatus('idle')
    setPreview(null)
    setMessage(null)
  }, [])

  async function post(input, dry) {
    const mine = ++gen.current
    setStatus('busy')
    setError(null)
    setMessage(null)
    const r = await authFetch('/api/desk/run', { method: 'POST', body: JSON.stringify({ job, input, dry }) })
    const j = r.data || {}
    if (mine !== gen.current && dry) return null
    if (!r.ok || j.ok === false || (j.error && !j.run)) {
      setError(j.error || (r.tokenRequired ? 'Not allowed: set the dashboard token in Settings.' : `HTTP ${r.status}`))
      setStatus('idle')
      setPreview(null)
      if (j.run) onBuilt?.()
      return null
    }
    return j
  }

  return {
    status, preview, message, error, reset,
    async runPreview(input) {
      const j = await post(input, true)
      if (!j) return
      setPreview(j)
      setStatus('previewed')
    },
    async runBuild(input, doneMsg) {
      const j = await post(input, false)
      if (!j) return
      setPreview(null)
      setStatus('applied')
      setMessage(doneMsg(j))
      onBuilt?.()
    },
  }
}

function Field({ label, children }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1 text-note text-muted">
      <span>{label}</span>
      {children}
    </div>
  )
}

// The IP space question, shared by the jobs that need one. The server orders
// the spaces (yours first, then the most room) and gives each a reason; the
// top three are offered as one-click suggestions above the full list.
function SpacePicker({ value, onChange }) {
  const api = useApi('/api/desk/spaces')
  const spaces = api.data?.spaces ?? []
  const picked = useRef(false)
  // Start on the first of your spaces, once, so the common case is one click
  // fewer. Never overrides a choice already made.
  useEffect(() => {
    if (!picked.current && !value && spaces[0]?.yours) {
      picked.current = true
      onChange(spaces[0].id)
    }
  }, [spaces, value, onChange])
  const suggested = spaces.slice(0, 3)
  return (
    <Field label="IP space">
      {suggested.length > 0 && (
        <div data-space-suggestions="" className="flex flex-wrap gap-2">
          {suggested.map((s) => (
            <button key={s.id} type="button" onClick={() => { picked.current = true; onChange(s.id) }}
              aria-pressed={s.id === value}
              className="text-left px-3 py-1.5 rounded-control border"
              style={s.id === value ? { borderColor: COLORS.accent, boxShadow: `inset 3px 0 0 ${COLORS.accent}` } : undefined}>
              <span className="block text-copy text-txt">{s.name || s.id}</span>
              <span className="block text-note text-muted">{s.reason || 'IP space'}</span>
            </button>
          ))}
        </div>
      )}
      <FilterSelect
        label="IP space"
        value={value}
        onChange={(v) => { picked.current = true; onChange(v) }}
        options={spaces.map((s) => ({ value: s.id, label: s.reason ? `${s.name || s.id} (${s.reason})` : (s.name || s.id) }))}
        placeholder={api.loading ? 'Loading IP spaces…' : 'Or pick any IP space'}
      />
      <FetchError error={api.error} stale={spaces.length > 0} />
    </Field>
  )
}

function IpJob({ onBuilt, ro }) {
  const [space, setSpace] = useState('')
  const subnetsApi = useApi(space ? `/api/ipam/subnets?space=${encodeURIComponent(space)}` : null)
  const [subnetId, setSubnetId] = useState('')
  const [name, setName] = useState('')
  const flow = useDeskFlow('ip', onBuilt)

  const subnets = subnetsApi.data?.subnets ?? []
  const subnet = subnets.find((s) => s.id === subnetId)
  const input = () => ({ space, subnet_id: subnetId, name: name.trim() })
  const { reset } = flow
  const pickSpace = useCallback((v) => { setSpace(v); setSubnetId(''); reset() }, [reset])
  const next = flow.preview?.addresses?.[0]?.address

  return (
    <div className="flex flex-col gap-3">
      <SpacePicker value={space} onChange={pickSpace} />
      <Field label="Network">
        <FilterSelect
          label="Network"
          value={subnetId}
          onChange={(v) => { setSubnetId(v); flow.reset() }}
          options={subnets.map((s) => ({ value: s.id, label: subnetLabel(s) }))}
          placeholder={space ? 'Pick a network' : 'Pick an IP space first'}
          disabled={!space}
        />
      </Field>
      <label className="flex flex-col gap-1 text-note text-muted">
        What is it for? (optional)
        <input {...MACHINE_TEXT} className={FIELD_CLS} value={name} placeholder="printer-02"
          onChange={(e) => { setName(e.target.value); flow.reset() }} />
      </label>
      <PreviewApply
        status={flow.status}
        disabled={!subnetId}
        applyDisabled={ro}
        applyNote="This account is read-only, so Build is off."
        onPreview={() => flow.runPreview(input())}
        onApply={() => flow.runBuild(input(), (j) => {
          const got = j.run?.objects?.find((o) => o.kind === 'address')?.label
          return got ? `Done. ${got} is reserved. Remove it any time from Your recent changes.` : 'Done.'
        })}
        applyLabel="Build it"
        error={flow.error}
        message={flow.message}
      >
        {flow.status === 'previewed' && (
          <PreviewBox>
            {next
              ? <p>This will reserve <strong>{next}</strong>{subnet ? ` in ${subnetLabel(subnet)}` : ''}{name.trim() ? `, for ${name.trim()}` : ''}.</p>
              : <p>Infoblox found no free address in this network.</p>}
          </PreviewBox>
        )}
      </PreviewApply>
      <FetchError error={subnetsApi.error} stale={subnets.length > 0} />
    </div>
  )
}

// The box a preview sits in, the same for every job.
function PreviewBox({ children }) {
  return (
    <div data-desk-preview="" className="rounded-control border border-border bg-field px-3 py-2 text-copy">
      <p className="font-medium" style={{ color: COLORS.ok }}>Ready to build. Nothing has been made yet.</p>
      {children}
    </div>
  )
}

function DnsJob({ onBuilt, ro }) {
  const zonesApi = useApi('/api/dns/zones')
  const [zoneId, setZoneId] = useState('')
  const [nameInZone, setNameInZone] = useState('')
  const [type, setType] = useState('A')
  const [value, setValue] = useState('')
  const flow = useDeskFlow('dns', onBuilt)
  const views = Object.fromEntries((zonesApi.data?.views ?? []).map((v) => [v.id, v.name]))
  const zones = zonesApi.data?.zones ?? []
  const zone = zones.find((z) => z.id === zoneId)
  const zoneName = (zone?.fqdn || '').replace(/\.$/, '')
  const full = nameInZone.trim() === '@' ? zoneName : `${nameInZone.trim()}${zoneName ? `.${zoneName}` : ''}`
  const input = () => ({ zone_id: zoneId, zone_name: zone?.fqdn || '', name_in_zone: nameInZone.trim(), type, value: value.trim() })
  const change = (set) => (v) => { set(v); flow.reset() }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Zone">
        <FilterSelect
          label="Zone"
          value={zoneId}
          onChange={change(setZoneId)}
          options={zones.map((z) => ({ value: z.id, label: `${(z.fqdn || z.id).replace(/\.$/, '')}${views[z.view] ? ` (${views[z.view]})` : ''}` }))}
          placeholder={zonesApi.loading ? 'Loading zones…' : 'Pick a zone'}
        />
      </Field>
      <label className="flex flex-col gap-1 text-note text-muted">
        Name (@ for the zone itself)
        <input {...MACHINE_TEXT} className={FIELD_CLS} value={nameInZone} placeholder="www"
          onChange={(e) => change(setNameInZone)(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-note text-muted">
        Kind of record
        <select className={FIELD_CLS} value={type} onChange={(e) => change(setType)(e.target.value)}>
          {DNS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-note text-muted">
        Points to
        <input {...MACHINE_TEXT} className={FIELD_CLS} value={value}
          placeholder={DNS_TYPES.find((t) => t.value === type)?.hint}
          onChange={(e) => change(setValue)(e.target.value)} />
      </label>
      <PreviewApply
        status={flow.status}
        disabled={!zoneId || !nameInZone.trim() || !value.trim()}
        applyDisabled={ro}
        applyNote="This account is read-only, so Build is off."
        onPreview={() => flow.runPreview(input())}
        onApply={() => flow.runBuild(input(), () => `Done. ${full} now points to ${value.trim()}. Remove it any time from Your recent changes.`)}
        applyLabel="Build it"
        error={flow.error}
        message={flow.message}
      >
        {flow.status === 'previewed' && (
          <PreviewBox>
            <p>This will add <strong>{full}</strong>, {type.startsWith('A') ? 'an' : 'a'} {type} record pointing to <strong>{value.trim()}</strong>.</p>
          </PreviewBox>
        )}
      </PreviewApply>
      <FetchError error={zonesApi.error} stale={zones.length > 0} />
    </div>
  )
}

const blockLabel = (b) => (b.address || '') + (b.cidr ? `/${b.cidr}` : '') + (b.name ? `, ${b.name}` : '')

function NetworkJob({ onBuilt, ro }) {
  const [space, setSpace] = useState('')
  const blocksApi = useApi(space ? `/api/ipam/blocks?space=${encodeURIComponent(space)}` : null)
  const [blockId, setBlockId] = useState('')
  const [cidr, setCidr] = useState('28')
  const [name, setName] = useState('')
  const flow = useDeskFlow('network', onBuilt)
  const blocks = blocksApi.data?.blocks ?? []
  const block = blocks.find((b) => b.id === blockId)
  const input = () => ({ space, block_id: blockId, cidr: Number(cidr), name: name.trim() })
  const { reset } = flow
  const pickSpace = useCallback((v) => { setSpace(v); setBlockId(''); reset() }, [reset])
  const would = flow.preview?.would_create

  return (
    <div className="flex flex-col gap-3">
      <SpacePicker value={space} onChange={pickSpace} />
      <Field label="Address block">
        <FilterSelect
          label="Address block"
          value={blockId}
          onChange={(v) => { setBlockId(v); flow.reset() }}
          options={blocks.map((b) => ({ value: b.id, label: blockLabel(b) }))}
          placeholder={space ? 'Pick the block to take it from' : 'Pick an IP space first'}
          disabled={!space}
        />
      </Field>
      <label className="flex flex-col gap-1 text-note text-muted">
        Size
        <select className={FIELD_CLS} value={cidr} onChange={(e) => { setCidr(e.target.value); flow.reset() }}>
          {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-note text-muted">
        Name (optional)
        <input {...MACHINE_TEXT} className={FIELD_CLS} value={name} placeholder="demo-lab"
          onChange={(e) => { setName(e.target.value); flow.reset() }} />
      </label>
      <PreviewApply
        status={flow.status}
        disabled={!blockId}
        applyDisabled={ro}
        applyNote="This account is read-only, so Build is off."
        onPreview={() => flow.runPreview(input())}
        onApply={() => flow.runBuild(input(), (j) => {
          const got = j.run?.objects?.find((o) => o.kind === 'subnet')?.label
          return got ? `Done. ${got} is made. Remove it any time from Your recent changes.` : 'Done.'
        })}
        applyLabel="Build it"
        error={flow.error}
        message={flow.message}
      >
        {flow.status === 'previewed' && (
          <PreviewBox>
            {would?.address && would.address_preview == null
              ? <p>This will make <strong>{would.address}/{cidr}</strong> ({2 ** (32 - Number(cidr))} addresses){block ? ` in ${blockLabel(block)}` : ''}{name.trim() ? `, named ${name.trim()}` : ''}.</p>
              : would?.address_preview === 'none-available'
                ? <p>This block has no free network of that size. Pick a smaller size or another block.</p>
                : <p>Infoblox could not say which network it would make{would?.reason ? ` (${would.reason})` : ''}. Try Preview again.</p>}
          </PreviewBox>
        )}
      </PreviewApply>
      <FetchError error={blocksApi.error} stale={blocks.length > 0} />
    </div>
  )
}

const STATUS_WORDS = {
  building: 'Building',
  built: 'Built',
  failed: 'Did not finish',
  removing: 'Removing',
  removed: 'Removed',
  'remove-failed': 'Some items could not be removed',
}

const OBJECT_WORDS = { created: '', removed: 'removed', gone: 'was already gone', failed: 'could not be removed' }

function when(iso) {
  const t = Date.parse(iso)
  if (!t) return ''
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// One row of Your recent changes, with its own Remove: first a list of what
// is still there, then a second click to delete it.
function RunRow({ run, onChanged, ro }) {
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const left = run.objects.filter((o) => o.state === 'created' || o.state === 'failed')
  const canRemove = left.length > 0 && run.status !== 'building' && run.status !== 'removing'

  async function call(dry) {
    setBusy(true)
    setError(null)
    const r = await authFetch('/api/desk/remove', { method: 'POST', body: JSON.stringify({ run: run.id, dry }) })
    setBusy(false)
    const j = r.data || {}
    if (dry) {
      if (!r.ok) setError(j.error || `HTTP ${r.status}`)
      else setPlan(j.would_remove || [])
      return
    }
    setPlan(null)
    if (!r.ok || j.ok === false) setError(j.error || `HTTP ${r.status}`)
    onChanged()
  }

  return (
    <li data-run={run.id} className="flex flex-col gap-1 px-3 py-2 border-b border-border last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-copy font-medium text-txt">{run.title}</p>
          <p className="text-note text-muted">
            {STATUS_WORDS[run.status] || run.status}{run.created ? `, ${when(run.created)}` : ''}
          </p>
        </div>
        {canRemove && !plan && (
          <button type="button" disabled={busy} onClick={() => call(true)}
            className="text-note px-2 py-1 rounded-control border border-border text-txt hover:border-border-hover">
            {busy ? 'Checking…' : 'Remove'}
          </button>
        )}
      </div>
      {run.error && <p className="text-note" style={{ color: COLORS.warn }}>{run.error}</p>}
      {run.note && <p className="text-note text-muted">{run.note}</p>}
      {run.objects.some((o) => OBJECT_WORDS[o.state]) && (
        <ul className="text-note text-muted">
          {run.objects.map((o) => <li key={o.id}>{o.label}{OBJECT_WORDS[o.state] ? `: ${OBJECT_WORDS[o.state]}` : ''}{o.error ? ` (${o.error})` : ''}</li>)}
        </ul>
      )}
      {plan && (
        <div data-remove-plan="" className="rounded-control border border-border bg-field px-3 py-2 flex flex-col gap-2">
          {plan.length === 0
            ? <p className="text-note">Nothing from this change is left to remove.</p>
            : <>
                <p className="text-note text-txt">This will delete:</p>
                <ul className="text-note list-disc pl-5">
                  {plan.map((o) => (
                    <li key={o.id}>
                      {o.label}{o.exists ? '' : o.gone ? ' (already gone)' : ` (could not check it, HTTP ${o.status})`}
                      {o.blocked && <span className="block" style={{ color: COLORS.warn }}>Will be kept: {o.blocked}</span>}
                    </li>
                  ))}
                </ul>
              </>}
          <div className="flex gap-2">
            {plan.length > 0 && (
              <button type="button" disabled={busy || ro} onClick={() => call(false)}
                className="text-note font-medium px-3 py-1 rounded-control"
                style={{ background: COLORS.crit, color: COLORS.onCrit }}>
                {busy ? 'Removing…' : 'Delete these'}
              </button>
            )}
            <button type="button" onClick={() => setPlan(null)}
              className="text-note px-3 py-1 rounded-control border border-border text-txt">Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="text-note" style={{ color: COLORS.crit }}>{error}</p>}
    </li>
  )
}

function RecentChanges({ api, ro }) {
  const list = api.data?.runs ?? []
  return (
    <Card panelId="automate-recent" title="Your recent changes" span={6}
      note="only changes made on this page; each one can be removed">
      {list.length === 0
        ? (!api.loading && <Empty>Nothing built here yet.</Empty>)
        : <ul data-recent-changes="">{list.map((r) => <RunRow key={r.id} run={r} ro={ro} onChanged={api.refetch} />)}</ul>}
      <FetchError error={api.error} stale={list.length > 0} />
    </Card>
  )
}

// Find: anything typed opens the existing search page, which looks it up in
// IPAM, DNS and the logs at once. Read-only.
function FindBox() {
  const [q, setQ] = useState('')
  return (
    <form role="search" aria-label="Find" className="flex gap-2"
      onSubmit={(e) => { e.preventDefault(); if (q.trim()) window.location.hash = `dossier?q=${encodeURIComponent(q.trim())}` }}>
      <input {...MACHINE_TEXT} aria-label="Find an address, network or name" className={`${FIELD_CLS} flex-1`}
        value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an address, network or name, like 10.2.1.7 or printer-02" />
      <button type="submit" disabled={!q.trim()} className="text-copy font-medium px-4 py-1.5 rounded-control"
        style={{ background: COLORS.accent, color: COLORS.onAccent }}>Find</button>
    </form>
  )
}

export default function Automate() {
  const ro = useReadOnly()
  const [job, setJob] = useState('ip')
  const runsApi = useApi('/api/desk/runs')
  const current = JOBS.find((j) => j.id === job)

  return (
    <>
      <div className="w-full px-6 py-5 flex flex-col gap-4">
        <div>
          <h1 className="text-copy font-semibold tracking-tight mb-1">Automate</h1>
          <TabIntro anchor="automate">
            Pick a job, answer a few questions, and check what will be made before you build it. Everything built
            here can be removed from Your recent changes. The full Provision, Self-Service and Demo server pages are
            still under All pages.
          </TabIntro>
        </div>
        <FindBox />
        <ReadOnlyNote ro={ro} what="Preview works, because it changes nothing. Build and Remove are off." />
        <div className="grid gap-4 md:grid-cols-[minmax(220px,1fr)_2fr]">
          <nav aria-label="Jobs to automate" className="flex flex-col rounded-control border border-border bg-card self-start">
            <h2 className="text-copy font-semibold px-3 pt-3 pb-2">What do you want to do?</h2>
            {JOBS.map((j) => (
              <button key={j.id} type="button" onClick={() => setJob(j.id)} aria-pressed={j.id === job}
                className="text-left px-3 py-2 border-t border-border hover:bg-line-2"
                style={j.id === job ? { boxShadow: `inset 4px 0 0 ${COLORS.accent}` } : undefined}>
                <span className="block text-copy font-medium" style={{ color: j.id === job ? COLORS.accent : undefined }}>{j.title}</span>
                <span className="block text-note text-muted">{j.says}</span>
              </button>
            ))}
          </nav>
          <Card panelId="automate-job" panelName="The job you picked" title={current.title} span={6}>
            {job === 'ip' && <IpJob ro={ro.readOnly} onBuilt={runsApi.refetch} />}
            {job === 'dns' && <DnsJob ro={ro.readOnly} onBuilt={runsApi.refetch} />}
            {job === 'network' && <NetworkJob ro={ro.readOnly} onBuilt={runsApi.refetch} />}
          </Card>
        </div>
        <RecentChanges api={runsApi} ro={ro.readOnly} />
      </div>
    </>
  )
}
