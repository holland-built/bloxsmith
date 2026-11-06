// The job desk: pick a job, answer a few plain questions, check what will be
// made, Build. Every Build is recorded with the exact Infoblox IDs it made
// (go/internal/runs), so "Your recent changes" can remove exactly that.
//
// The older pages (Provision, Self-Service, Demo server) stay as they are.
// Changes made there are not recorded here and cannot be removed from here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { authFetch } from '../lib/authFetch.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { ReadOnlyNote } from '../components/kit.jsx'
import { Card, COLORS, Empty, FetchError, FIELD_CLS, PreviewApply, TabIntro } from '../components/ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import FilterSelect from '../components/FilterSelect.jsx'
import { playbookFor } from '../lib/ansible.js'

const JOBS = [
  { id: 'ip', title: 'Get an IP address', says: 'The next free address in a network you pick' },
  { id: 'dns', title: 'Add a DNS name', says: 'A name that points at an address or another name' },
  { id: 'network', title: 'Make a new network', says: 'The next free network of the size you pick' },
  { id: 'branch', title: 'Set up a branch office', says: 'Networks, DHCP, a DNS zone and hosts from a site template' },
  { id: 'demo', title: 'Get a demo ready', says: 'A site, five sample DNS names and a demo server for a customer call' },
]

const REGIONS = [
  { value: 'amer', label: 'Americas' },
  { value: 'emea', label: 'Europe' },
  { value: 'apac', label: 'Asia Pacific' },
]

// Site and customer names become a DNS label, so the box lowercases as you type.
const siteText = (v) => v.toLowerCase().replace(/[^a-z0-9-]/g, '-')

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
  const spaces = useMemo(() => api.data?.spaces ?? [], [api.data])
  const picked = useRef(false)
  // Start on the first of your spaces, once, so the common case is one click
  // fewer. Never overrides a choice already made.
  useEffect(() => {
    if (!picked.current && !value && spaces[0]?.yours) {
      picked.current = true
      onChange(spaces[0].id, spaces[0].name)
    }
  }, [spaces, value, onChange])
  const suggested = spaces.slice(0, 3)
  return (
    <Field label="IP space">
      {suggested.length > 0 && (
        <div data-space-suggestions="" className="flex flex-wrap gap-2">
          {suggested.map((s) => (
            <button key={s.id} type="button" onClick={() => { picked.current = true; onChange(s.id, s.name) }}
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
        onChange={(v) => { picked.current = true; onChange(v, spaces.find((s) => s.id === v)?.name) }}
        options={spaces.map((s) => ({ value: s.id, label: s.reason ? `${s.name || s.id} (${s.reason})` : (s.name || s.id) }))}
        placeholder={api.loading ? 'Loading IP spaces…' : 'Or pick any IP space'}
      />
      <FetchError error={api.error} stale={spaces.length > 0} />
    </Field>
  )
}

function IpJob({ onBuilt, ro, start = {} }) {
  const [space, setSpace] = useState('')
  const subnetsApi = useApi(space ? `/api/ipam/subnets?space=${encodeURIComponent(space)}` : null)
  const [subnetId, setSubnetId] = useState('')
  const [name, setName] = useState(start.name || '')
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
      {showPlaybook(flow.status) && <CopyPlaybook job="ip" input={input()} />}
      <FetchError error={subnetsApi.error} stale={subnets.length > 0} />
    </div>
  )
}

// Copy as Ansible playbook: the same job written for Infoblox's
// infoblox.universal_ddi collection (lib/ansible.js), for running it from a
// pipeline instead. Shown once the answers have been previewed.
function CopyPlaybook({ job, input }) {
  const [copied, setCopied] = useState(null)
  const text = playbookFor(job, input)
  if (!text) return null
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('Copied. Paste it into a .yml file.')
    } catch {
      setCopied('Could not copy. Select the playbook below and copy it by hand.')
    }
  }
  return (
    <details data-ansible="" className="text-note">
      <summary className="cursor-pointer text-txt">Run this from Ansible instead</summary>
      <div className="flex flex-col gap-2 mt-2">
        <button type="button" onClick={copy} className="self-start text-note font-medium underline underline-offset-2"
          style={{ color: COLORS.accent }}>
          Copy as Ansible playbook
        </button>
        {copied && <p role="status" className="text-muted">{copied}</p>}
        <pre className="rounded-control border border-border bg-field px-3 py-2 overflow-x-auto text-note">{text}</pre>
      </div>
    </details>
  )
}

const showPlaybook = (status) => status === 'previewed' || status === 'applied'

// The box a preview sits in, the same for every job.
function PreviewBox({ children }) {
  return (
    <div data-desk-preview="" className="rounded-control border border-border bg-field px-3 py-2 text-copy">
      <p className="font-medium" style={{ color: COLORS.ok }}>Ready to build. Nothing has been made yet.</p>
      {children}
    </div>
  )
}

function DnsJob({ onBuilt, ro, start = {} }) {
  const zonesApi = useApi('/api/dns/zones')
  const [zoneId, setZoneId] = useState('')
  const [nameInZone, setNameInZone] = useState(start.name_in_zone || '')
  const [type, setType] = useState(start.type || 'A')
  const [value, setValue] = useState(start.value || '')
  const flow = useDeskFlow('dns', onBuilt)
  const views = Object.fromEntries((zonesApi.data?.views ?? []).map((v) => [v.id, v.name]))
  const zones = useMemo(() => zonesApi.data?.zones ?? [], [zonesApi.data])
  const zone = zones.find((z) => z.id === zoneId)
  // A zone named in a planned sentence is picked once the zones have loaded.
  const wantZone = (start.zone_name || '').replace(/\.$/, '').toLowerCase()
  useEffect(() => {
    if (!wantZone || zoneId) return
    const z = zones.find((x) => (x.fqdn || '').replace(/\.$/, '').toLowerCase() === wantZone)
    if (z) setZoneId(z.id)
  }, [zones, wantZone, zoneId])
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
      {showPlaybook(flow.status) && <CopyPlaybook job="dns" input={input()} />}
      <FetchError error={zonesApi.error} stale={zones.length > 0} />
    </div>
  )
}

// What a site preview will make, in one short list.
function SitePlan({ res }) {
  const subnets = res?.subnets ?? []
  const ranges = res?.dhcp_ranges ?? []
  const hosts = res?.hosts ?? []
  const zone = (res?.dns_zone_fqdn || '').replace(/\.$/, '')
  return (
    <ul className="list-disc pl-5">
      {subnets.map((n, i) => <li key={`s${i}`}>Network <strong>{n.address}</strong>{n.name ? `, ${n.name}` : ''}</li>)}
      {ranges.length > 0 && <li>{ranges.length} DHCP range{ranges.length === 1 ? '' : 's'}</li>}
      {zone && <li>DNS zone <strong>{zone}</strong>{res?.dns_zone_created === false ? ' (already there, kept as it is)' : ''}</li>}
      {hosts.length > 0 && <li>{hosts.length} host{hosts.length === 1 ? '' : 's'}: {hosts.map((h) => h.fqdn || h.hostname).filter(Boolean).join(', ')}</li>}
    </ul>
  )
}

function BranchJob({ onBuilt, ro, start = {} }) {
  const tplApi = useApi('/api/templates')
  const [template, setTemplate] = useState('')
  const [site, setSite] = useState(start.site || '')
  const [space, setSpace] = useState({ id: '', name: '' })
  const flow = useDeskFlow('branch', onBuilt)
  const { reset } = flow
  const pickSpace = useCallback((id, name) => { setSpace({ id, name: name || '' }); reset() }, [reset])
  const templates = useMemo(() => (Array.isArray(tplApi.data) ? tplApi.data : []).filter((t) => t.type === 'site' && t.valid), [tplApi.data])
  // A region from a planned sentence picks that region's lab template.
  useEffect(() => {
    if (!start.region || template) return
    const t = templates.find((x) => x.name.startsWith(`${start.region}/lab/`))
    if (t) setTemplate(t.name)
  }, [templates, start.region, template])
  const input = () => ({ template, site, space: space.id, space_name: space.name })

  return (
    <div className="flex flex-col gap-3">
      <Field label="Site template">
        <FilterSelect
          label="Site template"
          value={template}
          onChange={(v) => {
            setTemplate(v)
            if (!site) setSite(templates.find((t) => t.name === v)?.site || '')
            reset()
          }}
          options={templates.map((t) => ({ value: t.name, label: [t.site, t.region, t.environment].filter(Boolean).join(', ') }))}
          placeholder={tplApi.loading ? 'Loading templates…' : 'Pick a site template'}
        />
      </Field>
      <label className="flex flex-col gap-1 text-note text-muted">
        Site name
        <input {...MACHINE_TEXT} className={FIELD_CLS} value={site} placeholder="branch-boston"
          onChange={(e) => { setSite(siteText(e.target.value)); reset() }} />
      </label>
      <SpacePicker value={space.id} onChange={pickSpace} />
      <PreviewApply
        status={flow.status}
        disabled={!template || site.length < 2 || !space.id}
        applyDisabled={ro}
        applyNote="This account is read-only, so Build is off."
        onPreview={() => flow.runPreview(input())}
        onApply={() => flow.runBuild(input(), () => `Done. Branch office ${site} is set up. Remove it any time from Your recent changes.`)}
        applyLabel="Build it"
        error={flow.error}
        message={flow.message}
      >
        {flow.status === 'previewed' && (
          <PreviewBox>
            <p>This will make, for <strong>{site}</strong>{space.name ? ` in ${space.name}` : ''}:</p>
            <SitePlan res={flow.preview} />
          </PreviewBox>
        )}
      </PreviewApply>
      <FetchError error={tplApi.error} stale={templates.length > 0} />
    </div>
  )
}

function DemoJob({ onBuilt, ro, start = {} }) {
  const [space, setSpace] = useState({ id: '', name: '' })
  const [customer, setCustomer] = useState(start.customer || '')
  const [region, setRegion] = useState(start.region || 'amer')
  const [server, setServer] = useState(start.include_server ?? true)
  const flow = useDeskFlow('demo', onBuilt)
  const { reset } = flow
  const pickSpace = useCallback((id, name) => { setSpace({ id, name: name || '' }); reset() }, [reset])
  const input = () => ({ space: space.id, space_name: space.name, customer, region, include_server: server })
  const p = flow.preview

  return (
    <div className="flex flex-col gap-3">
      <SpacePicker value={space.id} onChange={pickSpace} />
      <label className="flex flex-col gap-1 text-note text-muted">
        Customer or call name
        <input {...MACHINE_TEXT} className={FIELD_CLS} value={customer} placeholder="acme-bank"
          onChange={(e) => { setCustomer(siteText(e.target.value)); reset() }} />
      </label>
      <fieldset className="flex flex-col gap-1 text-note text-muted">
        <legend>Region</legend>
        <div className="flex gap-4">
          {REGIONS.map((g) => (
            <label key={g.value} className="flex items-center gap-1 text-copy text-txt">
              <input type="radio" name="demo-region" value={g.value} checked={region === g.value}
                onChange={() => { setRegion(g.value); reset() }} />
              {g.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-copy text-txt">
        <input type="checkbox" checked={server} onChange={(e) => { setServer(e.target.checked); reset() }} />
        Include a demo DNS server (takes about 15 minutes, uses the Demo server settings)
      </label>
      <PreviewApply
        status={flow.status}
        disabled={!space.id || customer.length < 2}
        applyDisabled={ro}
        applyNote="This account is read-only, so Build is off."
        onPreview={() => flow.runPreview(input())}
        onApply={() => flow.runBuild(input(), () => server
          ? `The site and sample names for ${customer} are ready. The demo server is building now; its progress shows in Your recent changes.`
          : `Done. The demo for ${customer} is ready. Remove it any time from Your recent changes.`)}
        applyLabel="Build it"
        error={flow.error}
        message={flow.message}
      >
        {flow.status === 'previewed' && (
          <PreviewBox>
            <p>This will make, for <strong>{customer}</strong>{space.name ? ` in ${space.name}` : ''}:</p>
            <SitePlan res={p} />
            {(p?.sample_names ?? []).length > 0 && (
              <p>And these sample names: {(p.sample_names).map((n) => n.label).join('; ')}.</p>
            )}
            {server && p?.server && (p.server.ready
              ? <p>Then a demo DNS server that joins the Infoblox Portal.</p>
              : <p style={{ color: COLORS.warn }}>The demo server cannot start yet: {p.server.why} Turn it off above, or fix that on the <a className="underline" href="#demo">Demo server</a> page.</p>)}
          </PreviewBox>
        )}
      </PreviewApply>
    </div>
  )
}

const blockLabel = (b) => (b.address || '') + (b.cidr ? `/${b.cidr}` : '') + (b.name ? `, ${b.name}` : '')

function NetworkJob({ onBuilt, ro, start = {} }) {
  const [space, setSpace] = useState('')
  const blocksApi = useApi(space ? `/api/ipam/blocks?space=${encodeURIComponent(space)}` : null)
  const [blockId, setBlockId] = useState('')
  const [cidr, setCidr] = useState(String(start.cidr || 28))
  const [name, setName] = useState(start.name || '')
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
      {showPlaybook(flow.status) && <CopyPlaybook job="network" input={input()} />}
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
  ready: 'Ready',
}

const OBJECT_WORDS = { created: '', removed: 'removed', gone: 'was already gone', failed: 'could not be removed' }

function when(iso) {
  const t = Date.parse(iso)
  if (!t) return ''
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// One row of Your recent changes, with its own Remove: first a list of what
// is still there, then a second click to delete it.
// A demo server's own state, read from its run on the Demo server side.
const DEMO_WORDS = {
  building: 'building, about 15 minutes in all',
  ready: 'ready',
  failed: 'did not finish',
  removing: 'removing',
  'remove-failed': 'could not be fully removed',
  removed: 'removed',
}

// The join token is reused from the Demo server settings. An expired one
// cannot be spotted ahead of time; the server just never joins the Portal.
const joinFailed = (d) => d?.status === 'failed' && /join|portal/i.test(d.error || '')

function DemoServerLine({ o, info }) {
  if (!info) return <li>{o.label}{OBJECT_WORDS[o.state] ? `: ${OBJECT_WORDS[o.state]}` : ''}{o.error ? ` (${o.error})` : ''}</li>
  return (
    <li data-demo-server={o.id}>
      {info.ip ? `demo server ${info.ip}` : o.label}: {OBJECT_WORDS[o.state] && o.state !== 'created' ? OBJECT_WORDS[o.state] : (DEMO_WORDS[info.status] || info.status)}
      {info.status === 'failed' && info.error ? ` (${info.error})` : ''}
      {o.error ? ` (${o.error})` : ''}
      {joinFailed(info) && (
        <span className="block" style={{ color: COLORS.warn }}>
          If the join token has expired, paste a new one on the <a className="underline" href="#demo">Demo server</a> page, then Remove this and build it again.
        </span>
      )}
    </li>
  )
}

function RunRow({ run, onChanged, ro, demo = {}, removeBody }) {
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const left = run.objects.filter((o) => o.state === 'created' || o.state === 'failed')
  const canRemove = left.length > 0 && run.status !== 'building' && run.status !== 'removing'

  async function call(dry) {
    setBusy(true)
    setError(null)
    const r = await authFetch('/api/desk/remove', { method: 'POST', body: JSON.stringify({ ...(removeBody || { run: run.id }), dry }) })
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
      {run.objects.some((o) => OBJECT_WORDS[o.state] || o.kind === 'demo_server') && (
        <ul className="text-note text-muted">
          {run.objects.map((o) => o.kind === 'demo_server'
            ? <DemoServerLine key={o.id} o={o} info={demo[o.id]} />
            : <li key={o.id}>{o.label}{OBJECT_WORDS[o.state] ? `: ${OBJECT_WORDS[o.state]}` : ''}{o.error ? ` (${o.error})` : ''}</li>)}
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
                      {(o.parts ?? []).length > 0 && <span className="block text-muted">{o.parts.join('; ')}</span>}
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

// A demo server made on the Demo server page, shown as a change of its own.
const olderDemoRun = (d) => ({
  id: d.change, title: d.ip ? `Demo server ${d.ip}` : 'Demo server', created: d.created, status: d.status, error: d.error,
  objects: [{ id: d.change, kind: 'demo_server', label: 'demo server', state: d.status === 'removed' ? 'removed' : 'created' }],
})

function RecentChanges({ api, ro }) {
  const list = api.data?.runs ?? []
  const demo = api.data?.demo ?? {}
  const older = api.data?.older_demos ?? []
  // While a change or its demo server is still going, check every 20 seconds.
  const building = list.some((r) => r.status === 'building' || r.status === 'removing') ||
    Object.values(demo).some((d) => d.status === 'building' || d.status === 'removing')
  const { refetch } = api
  useEffect(() => {
    if (!building) return undefined
    const t = setInterval(refetch, 20000)
    return () => clearInterval(t)
  }, [building, refetch])
  return (
    <Card panelId="automate-recent" title="Your recent changes" span={6}
      note="only changes made on this page; each one can be removed">
      {list.length === 0
        ? (!api.loading && <Empty>Nothing built here yet.</Empty>)
        : <ul data-recent-changes="">{list.map((r) => <RunRow key={r.id} run={r} ro={ro} demo={demo} onChanged={refetch} />)}</ul>}
      {older.length > 0 && (
        <div data-older-demos="" className="mt-3">
          <h3 className="text-copy font-medium px-3">Demo servers made on the Demo server page</h3>
          <p className="text-note text-muted px-3">Still running. Each is removed only when you press Remove.</p>
          <ul>
            {older.map((d) => (
              <RunRow key={d.change} run={olderDemoRun(d)} ro={ro} demo={{ [d.change]: d }}
                removeBody={{ demo_change: d.change }} onChanged={refetch} />
            ))}
          </ul>
        </div>
      )}
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

// Describe it in one sentence: the AI suggests which jobs and fills in what it
// can. It builds nothing. Each job opens in its form for the person to check,
// preview and build.
function PlanBox({ onOpen }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState(null)
  async function ask(e) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    setPlan(null)
    const r = await authFetch('/api/desk/plan', { method: 'POST', body: JSON.stringify({ sentence: text.trim() }) })
    setBusy(false)
    if (!r.ok) setError(r.data?.error || `HTTP ${r.status}`)
    else setPlan(r.data)
  }
  const titleOf = (id) => JOBS.find((j) => j.id === id)?.title || id
  return (
    <div className="flex flex-col gap-2">
      <form aria-label="Describe it in one sentence" className="flex gap-2" onSubmit={ask}>
        <input aria-label="Or describe it in one sentence" className={`${FIELD_CLS} flex-1`} value={text}
          onChange={(e) => setText(e.target.value)} placeholder="Or describe it: set up a lab in Austin and a demo for acme-bank" />
        <button type="submit" disabled={busy || !text.trim()} className="text-copy font-medium px-4 py-1.5 rounded-control"
          style={{ background: COLORS.accent, color: COLORS.onAccent }}>{busy ? 'Planning…' : 'Plan it'}</button>
      </form>
      {error && <p className="text-note" style={{ color: COLORS.crit }}>{error}</p>}
      {plan && (
        <div data-plan="" className="rounded-control border border-border bg-field px-3 py-2 flex flex-col gap-2 text-copy">
          {plan.jobs.length === 0
            ? <p>No job matched that. Pick one from the list below.</p>
            : <p className="text-note text-muted">The AI filled in what it could. Nothing is built until you preview and build each job.</p>}
          {plan.jobs.map((j, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="flex-1">
                <p className="font-medium text-txt">{titleOf(j.job)}</p>
                {j.says && <p className="text-note text-muted">{j.says}</p>}
              </div>
              <button type="button" onClick={() => onOpen(j)} className="text-note font-medium underline underline-offset-2"
                style={{ color: COLORS.accent }}>Open this job</button>
            </div>
          ))}
          {plan.unclear && <p className="text-note" style={{ color: COLORS.warn }}>Not planned: {plan.unclear}</p>}
        </div>
      )}
    </div>
  )
}

export default function Automate() {
  const ro = useReadOnly()
  const [job, setJob] = useState('ip')
  // Answers from Plan it, and a counter so a newly opened job starts fresh.
  const [start, setStart] = useState({ n: 0, answers: {} })
  const pick = (id, answers = {}) => { setJob(id); setStart((s) => ({ n: s.n + 1, answers })) }
  const runsApi = useApi('/api/desk/runs')
  const current = JOBS.find((j) => j.id === job)

  return (
    <>
      <div className="w-full px-6 py-5 flex flex-col gap-4">
        <div>
          <h1 className="text-copy font-semibold tracking-tight mb-1">Automate</h1>
          <TabIntro>Pick a job, answer a few questions, and check what will be made before you build it.</TabIntro>
        </div>
        <FindBox />
        <PlanBox onOpen={(j) => pick(j.job, j.answers)} />
        <ReadOnlyNote ro={ro} what="Preview works, because it changes nothing. Build and Remove are off." />
        <div className="grid gap-4 md:grid-cols-[minmax(220px,1fr)_2fr]">
          <nav aria-label="Jobs to automate" className="flex flex-col rounded-control border border-border bg-card self-start">
            <h2 className="text-copy font-semibold px-3 pt-3 pb-2">What do you want to do?</h2>
            {JOBS.map((j) => (
              <button key={j.id} type="button" onClick={() => pick(j.id)} aria-pressed={j.id === job}
                className="text-left px-3 py-2 border-t border-border hover:bg-line-2"
                style={j.id === job ? { boxShadow: `inset 4px 0 0 ${COLORS.accent}` } : undefined}>
                <span className="block text-copy font-medium" style={{ color: j.id === job ? COLORS.accent : undefined }}>{j.title}</span>
                <span className="block text-note text-muted">{j.says}</span>
              </button>
            ))}
          </nav>
          <Card panelId="automate-job" panelName="The job you picked" title={current.title} span={6}>
            {job === 'ip' && <IpJob key={start.n} start={start.answers} ro={ro.readOnly} onBuilt={runsApi.refetch} />}
            {job === 'dns' && <DnsJob key={start.n} start={start.answers} ro={ro.readOnly} onBuilt={runsApi.refetch} />}
            {job === 'network' && <NetworkJob key={start.n} start={start.answers} ro={ro.readOnly} onBuilt={runsApi.refetch} />}
            {job === 'branch' && <BranchJob key={start.n} start={start.answers} ro={ro.readOnly} onBuilt={runsApi.refetch} />}
            {job === 'demo' && <DemoJob key={start.n} start={start.answers} ro={ro.readOnly} onBuilt={runsApi.refetch} />}
          </Card>
        </div>
        <RecentChanges api={runsApi} ro={ro.readOnly} />
      </div>
    </>
  )
}
