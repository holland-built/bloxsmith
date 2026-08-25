import { useEffect, useRef, useState } from 'react'
// FetchError is the same shared component SelfService.jsx uses. /api/ipam/spaces
// and /api/ipam/blocks answer 502 on an upstream failure and /api/templates
// answers 500 — and `data?.spaces ?? []` collapses every one of those into the
// empty array a tenant that genuinely owns nothing produces. Unread, the select
// falls back to its placeholder and Apply sits disabled with no reason given.
import { Card, CardGrid, COLORS, Empty, FetchError, FIELD_CLS, PreviewApply, TabIntro } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'
import { dhcpSkips } from '../lib/dhcpSkips.js'
import { withToken } from '../lib/authFetch.js'
import { templateScanErrors } from '../lib/templateScanErrors.js'

const inputCls = `${FIELD_CLS} w-full`

export default function Provision() {
  const [mode, setMode] = useState('subnet') // 'subnet' | 'site' | 'seed'
  const whoami = useApi('/api/whoami')
  const role = whoami.data?.role || 'viewer'
  const isAdmin = role === 'admin'

  return (
    <div className="max-w-[720px] mx-auto p-5">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-title font-semibold tracking-tight">Provision</h1>
        <span
          className="text-caption font-medium px-2 py-0.5 rounded-full"
          style={{
            background: isAdmin ? 'var(--pill-ok-bg)' : role === 'operator' ? 'var(--pill-warn-bg)' : 'var(--pill-crit-bg)',
            color: isAdmin ? 'var(--pill-ok-fg)' : role === 'operator' ? 'var(--pill-warn-fg)' : 'var(--pill-crit-fg)',
          }}
        >
          {role.toUpperCase()}
        </span>
      </div>

      <TabIntro anchor="provision">
        Creates real objects in Infoblox — one subnet, a whole site from a template, or a multi-region demo
        estate. Preview streams the full plan without writing anything; Apply then runs it. Teardown is permanent
        and needs admin.
      </TabIntro>

      <div className="flex gap-1 mb-4 p-1 rounded-control bg-field border border-border w-fit">
        {[
          ['subnet', 'Subnet'],
          ['site', 'Full site'],
          ['seed', 'Seed demo'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={`px-3 py-1.5 rounded-control text-body font-medium ${
              mode === key ? 'bg-accent text-on-accent' : 'text-muted'
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

// ---------- shared stream flow ----------
//
// Every provision and teardown path is the same server-sent-event stream with a
// dry flag, so they share one driver instead of five near-identical copies of
// the EventSource wiring. Preview runs with dry=1 and lands in 'previewed';
// Apply re-runs the identical query with dry=0.
//
// Note the honest limit: the server re-plans on apply, so unlike the
// request/response surfaces this cannot submit the exact bytes you previewed.
// What it does guarantee is that the inputs are unchanged — markStale hides
// Apply the moment any field moves — so the plan is regenerated from the same
// request, not a silently different one.

function useStreamFlow(path) {
  const [status, setStatus] = useState('idle') // idle | busy | previewed | applied
  const [stale, setStale] = useState(false)
  const [log, setLog] = useState([])
  const [rows, setRows] = useState({})
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  // The failure frame carries a rollback report alongside the error string.
  // Keeping only the string threw away the one fact the operator needs most —
  // what cleanup could NOT delete, i.e. what is still live on their network —
  // and sent them to the audit log to find it.
  const [rollback, setRollback] = useState(null)
  const esRef = useRef(null)
  const dryRef = useRef(true)

  useEffect(() => () => esRef.current?.close(), [])

  function markStale() {
    if (status === 'previewed') setStale(true)
  }

  function run(qs, dry) {
    if (status === 'busy' || esRef.current) return
    setLog([]); setRows({}); setResult(null); setError(null); setRollback(null); setStatus('busy')
    dryRef.current = dry
    // withToken: EventSource can't send X-Auth-Token, so a token deployment
    // needs the ?token= query fallback or the stream 403s.
    const es = new EventSource(withToken(`${path}?${qs}`))
    esRef.current = es
    const stop = (next) => { esRef.current?.close(); esRef.current = null; setStatus(next) }
    es.onmessage = (e) => {
      let j = null
      try { j = JSON.parse(e.data) } catch { return }
      setLog((prev) => [...prev, j])
      if (j?.template) setRows((prev) => ({ ...prev, [j.template]: { phase: j.phase, error: j.error } }))
      // `rollback` is absent on frames from an older server — that is an
      // unknown answer, held as null so it renders as nothing at all rather
      // than as a confident all-clear.
      if (j?.error && !j.template) { setError(j.error); setRollback(j.rollback ?? null); stop('idle') }
      else if (j?.done) {
        setResult(j)
        setStale(false)
        stop(dryRef.current ? 'previewed' : 'applied')
      }
    }
    es.onerror = () => { if (!esRef.current) return; setError((p) => p || 'Stream connection error'); stop('idle') }
  }

  return { status, stale, log, rows, result, error, rollback, markStale, run }
}

// ---------- rollback report ----------
//
// What the server attempted to undo after a provision failed, and — the part
// that matters — what it could not. A residual object is still live on the
// customer's network: it was created by the run that failed and cleanup could
// not delete it, so someone has to go remove it by hand.
//
// Only 'incomplete' is critical. 'complete' and 'not_needed' are calm one-
// liners, because they are the answer "nothing is left behind". Both silent
// cases are silent on purpose: 'skipped_dry_run' means no cleanup was ever
// attempted (a preview writes nothing, so there is nothing to report), and an
// absent/unrecognised outcome means the server did not tell us — and an
// unknown answer must never be painted as a reassuring one.
function RollbackReport({ report }) {
  if (!report) return null
  const residual = Array.isArray(report.residual) ? report.residual : []
  const deleted = report.deleted ?? 0
  const attempted = report.attempted ?? 0

  if (report.outcome === 'incomplete') {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="text-body font-semibold" style={{ color: COLORS.crit }}>
          Cleanup could not remove {residual.length || attempted - deleted} object
          {(residual.length || attempted - deleted) === 1 ? '' : 's'} — they are still live on the customer&rsquo;s
          network
        </div>
        <div className="text-[12px] text-dim mb-1">{deleted} of {attempted} removed</div>
        {residual.map((o, i) => (
          <div key={o?.id || i} className="font-mono text-[12px]" style={{ color: COLORS.crit }}>
            ✕ {o?.kind || 'object'}{' '}
            <code className="font-mono text-[10.5px] px-1 py-0.5 rounded-mark bg-field">{o?.label || o?.id || '—'}</code>
            {o?.status ? <span className="text-dim"> (HTTP {o.status})</span> : null}
          </div>
        ))}
      </div>
    )
  }
  if (report.outcome === 'complete') {
    return (
      <div className="text-[12px] text-dim">
        Cleanup removed all {deleted} object{deleted === 1 ? '' : 's'} it had created — nothing was left behind.
      </div>
    )
  }
  if (report.outcome === 'not_needed') {
    return <div className="text-[12px] text-dim">Nothing had been created, so nothing needed removing.</div>
  }
  return null
}

// ---------- log rendering ----------

function LogView({ log, doneLabel }) {
  if (log.length === 0) return <Empty>Output appears here when you preview or apply.</Empty>
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

function RowsRollup({ rows, failedLabel }) {
  const rs = Object.values(rows)
  const total = Object.keys(rows).length
  const failed = rs.filter((r) => r?.error).length
  const done = rs.filter((r) => r && !r.error).length
  if (total === 0) return <Empty>Per-template status appears here once the run starts.</Empty>
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

const previewMsg = (verb) => `Preview only — nothing has been written. Review the plan, then ${verb}.`

// runOutcome classifies a finished seed/teardown-seed run from the terminal
// stream frame's explicit counts (backend now ships succeeded/failed/skipped/
// total ints alongside the raw summary arrays — see terminalFrame in
// provision.go). Before this, the UI had only `done`, so a run where every
// template failed rendered the exact same success banner as one where every
// template succeeded. total === 0 (nothing selected) is legitimate, not a
// failure — it reads as 'success' below.
function runOutcome(result) {
  if (!result) return null
  const succeeded = result.succeeded ?? 0
  const failed = result.failed ?? 0
  const skipped = result.skipped ?? 0
  const total = result.total ?? (succeeded + failed + skipped)
  if (total > 0 && failed === total) return { kind: 'failed', succeeded, failed, skipped, total }
  if (failed > 0) return { kind: 'partial', succeeded, failed, skipped, total }
  return { kind: 'success', succeeded, failed, skipped, total }
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

  const flow = useStreamFlow('/api/provision/stream')

  function qs(dry) {
    return new URLSearchParams({
      space, block, cidr: String(cidr || 24), name, comment,
      make_zone: makeZone ? '1' : '0', dry: dry ? '1' : '0',
    }).toString()
  }

  const subnet = flow.result?.subnet

  return (
    // One saved arrangement PER MODE, not per tab. Provision renders a
    // different grid for each mode and only one is ever mounted, so a single
    // shared key would make each mode's save overwrite the others' order with
    // a list naming only its own panels.
    <CardGrid layoutKey="provision-subnet">
      <Card key="provision-subnet-request" title="Request" panelId="provision-subnet-request" span={6}>
        <div className="flex flex-col gap-3">
          <Field label="Space">
            <select className={inputCls} value={space} onChange={(e) => { setSpace(e.target.value); setBlock(''); flow.markStale() }}>
              <option value="">{spacesApi.loading ? 'Loading spaces…' : 'Select a space'}</option>
              {spaces.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
            </select>
          </Field>
          <Field label="Block">
            <select className={inputCls} value={block} onChange={(e) => { setBlock(e.target.value); flow.markStale() }} disabled={!space}>
              <option value="">{blocksApi.loading ? 'Loading blocks…' : 'Select a block'}</option>
              {blocks.map((b) => <option key={b.id} value={b.id}>{b.name || b.cidr || b.address}</option>)}
            </select>
          </Field>
          <Field label="CIDR prefix">
            <input type="number" min="1" max="32" className={inputCls} value={cidr} onChange={(e) => { setCidr(e.target.value); flow.markStale() }} />
          </Field>
          <Field label="Name">
            <input className={inputCls} value={name} onChange={(e) => { setName(e.target.value); flow.markStale() }} placeholder="subnet name" />
          </Field>
          <Field label="Comment">
            <input className={inputCls} value={comment} onChange={(e) => { setComment(e.target.value); flow.markStale() }} placeholder="optional" />
          </Field>
          <CheckRow checked={makeZone} onChange={(v) => { setMakeZone(v); flow.markStale() }} label="Create matching DNS zone" />

          <div>
            <FetchError error={spacesApi.error} stale={spaces.length > 0} />
            <FetchError error={blocksApi.error} stale={blocks.length > 0} />
            {!spacesApi.loading && !spacesApi.error && spaces.length === 0 && <Empty>no IP spaces</Empty>}
            {space && !blocksApi.loading && !blocksApi.error && blocks.length === 0 && <Empty>no address blocks</Empty>}
          </div>

          <PreviewApply
            status={flow.status}
            stale={flow.stale}
            disabled={!space}
            onPreview={() => flow.run(qs(true), true)}
            onApply={() => flow.run(qs(false), false)}
            applyLabel="Provision"
            busyLabel="Running…"
            error={flow.error}
            message={
              flow.status === 'previewed' ? previewMsg('Provision')
                : flow.status === 'applied' ? `Provisioned — subnet ${subnet?.address || subnet?.id || ''}`
                : null
            }
          >
            <RollbackReport report={flow.rollback} />
          </PreviewApply>
        </div>
      </Card>

      <Card key="provision-subnet-log" title="Live log" panelId="provision-subnet-log" span={6}>
        <LogView log={flow.log} doneLabel={flow.status === 'previewed' ? 'plan complete — nothing written' : 'done'} />
      </Card>

      {flow.status === 'applied' && subnet && (
        <Card key="provision-subnet-result" title="Result" panelId="provision-subnet-result" span={6}>
          <div className="font-mono text-[12px]">
            Subnet id: {subnet.id ?? '—'} · {subnet.address || ''}{subnet.cidr ? `/${subnet.cidr}` : ''}
          </div>
        </Card>
      )}
    </CardGrid>
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
  const [tdConfirm, setTdConfirm] = useState('')

  const build = useStreamFlow('/api/provision/site/stream')
  const teardown = useStreamFlow('/api/teardown/site/stream')

  function baseQs(dry) {
    const q = new URLSearchParams({ template: siteTemplate, dry: dry ? '1' : '0' })
    if (siteSpace) q.set('ip_space', siteSpace)
    return q
  }
  function tdQs(dry) {
    const q = baseQs(dry)
    if (!dry) q.set('confirm', tdConfirm.trim())
    return q.toString()
  }

  function onInput(fn) {
    return (v) => { fn(v); build.markStale(); teardown.markStale() }
  }

  const built = build.result?.result

  return (
    // Its own key, for the reason spelled out on the subnet grid above.
    <CardGrid layoutKey="provision-site">
      <Card key="provision-site-request" title="Request" panelId="provision-site-request" span={6}>
        <div className="flex flex-col gap-3">
          <Field label="IP space (override)">
            <select className={inputCls} value={siteSpace} onChange={(e) => onInput(setSiteSpace)(e.target.value)}>
              <option value="">— template default —</option>
              {spaces.map((sp) => <option key={sp.id} value={sp.name}>{sp.name}</option>)}
            </select>
          </Field>
          <Field label="Template">
            <select className={inputCls} value={siteTemplate} onChange={(e) => onInput(setSiteTemplate)(e.target.value)}>
              <option value="">{templatesApi.loading ? 'Loading templates…' : 'Select a template'}</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name} disabled={t.valid === false}>
                  {t.name} — {t.region || ''}/{t.environment || ''}{t.valid === false ? ' (invalid)' : ''}
                </option>
              ))}
            </select>
          </Field>

          {/* "(invalid)" in the dropdown cannot tell a typo in the YAML from a
              permission bit, and those need completely different fixes. These
              entries used to be dropped by the server entirely, so the list was
              just shorter than the directory and there was nothing to act on. */}
          {templateScanErrors(templates).length > 0 && (
            <div className="flex flex-col gap-0.5">
              <div className="text-[12px] text-muted">Could not be read:</div>
              {templateScanErrors(templates).map((s) => (
                <div key={s.key} className="font-mono text-[12px]" style={{ color: COLORS.crit }}>
                  ✕ {s.name} — {s.reason}
                </div>
              ))}
            </div>
          )}

          <div>
            <FetchError error={spacesApi.error} stale={spaces.length > 0} />
            <FetchError error={templatesApi.error} stale={templates.length > 0} />
            {!spacesApi.loading && !spacesApi.error && spaces.length === 0 && <Empty>no IP spaces</Empty>}
            {!templatesApi.loading && !templatesApi.error && templates.length === 0 && <Empty>no templates</Empty>}
          </div>

          <PreviewApply
            status={build.status}
            stale={build.stale}
            disabled={!siteTemplate}
            onPreview={() => build.run(baseQs(true).toString(), true)}
            onApply={() => build.run(baseQs(false).toString(), false)}
            applyLabel="Provision site"
            busyLabel="Running…"
            error={build.error}
            message={
              build.status === 'previewed' ? previewMsg('Provision site')
                : build.status === 'applied' ? 'Site provisioned.'
                : null
            }
          >
            <RollbackReport report={build.rollback} />
          </PreviewApply>
        </div>
      </Card>

      <Card key="provision-site-log" title="Live log" panelId="provision-site-log" span={6}>
        <LogView log={build.log} doneLabel={build.status === 'previewed' ? 'plan complete — nothing written' : 'done'} />
      </Card>

      {/* Its own card, and NOT gated on 'applied': the Result card below only
          renders once the site has been written, and a preview is the run where
          learning a DHCP range cannot be placed still costs nothing. */}
      {dhcpSkips(built).length > 0 && (
        <Card key="provision-site-dhcp-skips" title="DHCP ranges not created" panelId="provision-site-dhcp-skips" span={6}>
          <div className="flex flex-col gap-0.5">
            {dhcpSkips(built).map((s) => (
              <div key={s.key} className="font-mono text-[12px]" style={{ color: COLORS.crit }}>
                ✕ {s.name}{s.subnet ? ` on ${s.subnet}` : ''}{s.range ? ` (${s.range})` : ''} — {s.reason}
              </div>
            ))}
          </div>
        </Card>
      )}

      {build.status === 'applied' && built && (
        <Card key="provision-site-result" title="Result" panelId="provision-site-result" span={6}>
          {built.skipped ? (
            <div className="font-mono text-[12px] text-muted">Skipped — {built.skip_reason || 'already provisioned'}.</div>
          ) : (
            <div className="font-mono text-[12px] flex flex-col gap-0.5">
              <div><span className="text-muted">Block: </span>{built.block_address || '—'}</div>
              <div><span className="text-muted">DNS zone: </span>{built.dns_zone_fqdn || '—'}</div>
              <div>
                <span className="text-muted">Subnets: </span>{(built.subnets || []).length} ·{' '}
                <span className="text-muted">DHCP ranges: </span>{(built.dhcp_ranges || []).length} ·{' '}
                <span className="text-muted">Hosts: </span>{(built.hosts || []).length}
              </div>
            </div>
          )}
        </Card>
      )}

      <Card key="provision-site-teardown" title="Tear down this site" note="permanently deletes its provisioned objects" panelId="provision-site-teardown" span={6}>
        <div className="flex flex-col gap-3">
          {isAdmin ? (
            <Field label="Type the site name to confirm">
              <input className={inputCls} value={tdConfirm} onChange={(e) => { setTdConfirm(e.target.value); teardown.markStale() }} placeholder={siteTemplate || 'site name'} />
            </Field>
          ) : (
            <div className="text-caption" style={{ color: COLORS.warn }}>Admin (dashboard token) required for live teardown</div>
          )}

          <PreviewApply
            status={teardown.status}
            stale={teardown.stale}
            disabled={!siteTemplate}
            applyDisabled={!isAdmin || !tdConfirm.trim()}
            applyNote={isAdmin ? 'type the site name to confirm' : 'admin required'}
            onPreview={() => teardown.run(tdQs(true), true)}
            onApply={() => teardown.run(tdQs(false), false)}
            applyLabel="Tear down this site"
            busyLabel="Running…"
            destructive
            error={teardown.error}
            message={
              teardown.status === 'previewed' ? previewMsg('Tear down this site')
                : teardown.status === 'applied' ? 'Teardown complete.'
                : null
            }
          />
        </div>
      </Card>

      {teardown.log.length > 0 && (
        <Card key="provision-site-teardown-log" title="Teardown log" panelId="provision-site-teardown-log" span={6}>
          <LogView log={teardown.log} doneLabel={teardown.status === 'previewed' ? 'plan complete — nothing deleted' : 'done'} />
        </Card>
      )}
      {teardown.result?.result && (
        <Card key="provision-site-teardown-result" title={teardown.status === 'previewed' ? 'Teardown plan' : 'Teardown result'} panelId="provision-site-teardown-result" span={6}>
          <div className="font-mono text-[12px] flex flex-col gap-0.5">
            <div><span className="text-muted">Site: </span>{teardown.result.result.site || siteTemplate || '—'}</div>
            <div>
              <span className="text-muted">DNS zone: </span>{teardown.result.result.dns_zone_fqdn || '—'}{' '}
              {teardown.result.result.dns_zone_deleted ? '(deleted)' : '(kept)'}
            </div>
            <div>
              <span className="text-muted">Subnets: </span>{(teardown.result.result.subnets_deleted || []).length} ·{' '}
              <span className="text-muted">DHCP ranges: </span>{(teardown.result.result.dhcp_ranges_deleted || []).length} ·{' '}
              <span className="text-muted">Hosts: </span>{(teardown.result.result.hosts_deleted || []).length} deleted
            </div>
            {teardown.status === 'previewed' && <div style={{ color: COLORS.warn }}>Preview — nothing was deleted.</div>}
          </div>
        </Card>
      )}
    </CardGrid>
  )
}

// ---------- seed demo mode ----------

function SeedMode({ isAdmin }) {
  const spacesApi = useApi('/api/ipam/spaces')
  const spaces = spacesApi.data?.spaces ?? []

  const [regions, setRegions] = useState({ amer: true, emea: true, apac: true })
  const [seedSpace, setSeedSpace] = useState('')
  const [tdConfirm, setTdConfirm] = useState('')

  const seed = useStreamFlow('/api/provision/seed-demo/stream')
  const teardown = useStreamFlow('/api/teardown/seed-demo/stream')

  const regionList = Object.keys(regions).filter((r) => regions[r])

  function baseQs(dry) {
    const q = new URLSearchParams({ dry: dry ? '1' : '0', regions: regionList.join(',') })
    if (seedSpace) q.set('ip_space', seedSpace)
    return q
  }
  function tdQs(dry) {
    const q = baseQs(dry)
    q.set('confirm', dry ? '' : 'DELETE')
    return q.toString()
  }
  function touch() { seed.markStale(); teardown.markStale() }

  const seedOutcome = runOutcome(seed.result)
  const teardownOutcome = runOutcome(teardown.result)

  return (
    // Its own key, for the reason spelled out on the subnet grid above.
    <CardGrid layoutKey="provision-seed">
      <Card key="provision-seed-request" title="Seed multi-region demo data" panelId="provision-seed-request" span={6}>
        <div className="text-caption text-dim mb-3">
          Provisions a full set of demo sites, subnets, and zones across the selected regions from the template
          library. Preview the plan before writing real objects — this creates a lot of them.
        </div>
        <div className="flex flex-col gap-3">
          {['amer', 'emea', 'apac'].map((r) => (
            <CheckRow
              key={r}
              checked={!!regions[r]}
              onChange={(v) => { setRegions((prev) => ({ ...prev, [r]: v })); touch() }}
              label={r.toUpperCase()}
            />
          ))}
          <Field label="IP space (override)">
            <select className={inputCls} value={seedSpace} onChange={(e) => { setSeedSpace(e.target.value); touch() }}>
              <option value="">— template default —</option>
              {spaces.map((sp) => <option key={sp.id} value={sp.name}>{sp.name}</option>)}
            </select>
          </Field>

          <div>
            <FetchError error={spacesApi.error} stale={spaces.length > 0} />
            {!spacesApi.loading && !spacesApi.error && spaces.length === 0 && <Empty>no IP spaces</Empty>}
          </div>

          <PreviewApply
            status={seed.status}
            stale={seed.stale}
            disabled={!regionList.length}
            onPreview={() => seed.run(baseQs(true).toString(), true)}
            onApply={() => seed.run(baseQs(false).toString(), false)}
            applyLabel="Seed demo data"
            busyLabel="Running…"
            error={
              seed.error ||
              (seed.status === 'applied' && seedOutcome?.kind === 'failed'
                ? `Seed failed — 0 of ${seedOutcome.total} template(s) succeeded.`
                : null)
            }
            message={
              seed.status === 'previewed' ? previewMsg('Seed demo data')
                : seed.status === 'applied' && seedOutcome?.kind === 'partial'
                  ? `Seed partial — ${seedOutcome.succeeded} of ${seedOutcome.total} succeeded, ${seedOutcome.failed} failed.`
                : seed.status === 'applied' && seedOutcome?.kind === 'success' ? 'Seed complete.'
                : null
            }
          >
            <RollbackReport report={seed.rollback} />
          </PreviewApply>
        </div>
      </Card>

      <Card key="provision-seed-progress" title="Progress" panelId="provision-seed-progress" span={6}>
        <RowsRollup rows={seed.rows} />
      </Card>

      <Card key="provision-seed-log" title="Live log" panelId="provision-seed-log" span={6}>
        <LogView log={seed.log} doneLabel={seed.status === 'previewed' ? 'plan complete — nothing written' : 'done'} />
      </Card>

      {seedOutcome && (
        <Card key="provision-seed-summary" title={seed.status === 'previewed' ? 'Planned' : 'Summary'} panelId="provision-seed-summary" span={6}>
          <div className="font-mono text-[12px]">
            Succeeded: {seedOutcome.succeeded} · Failed: {seedOutcome.failed} · Skipped: {seedOutcome.skipped}
          </div>
        </Card>
      )}

      <Card key="provision-seed-teardown" title="Tear down demo" note={`permanently deletes every seed-created object in ${seedSpace || 'the default space'}`} panelId="provision-seed-teardown" span={6}>
        <div className="flex flex-col gap-3">
          {isAdmin ? (
            <Field label="Type DELETE to confirm">
              <input className={inputCls} value={tdConfirm} onChange={(e) => { setTdConfirm(e.target.value); teardown.markStale() }} placeholder="DELETE" />
            </Field>
          ) : (
            <div className="text-caption" style={{ color: COLORS.warn }}>Admin (dashboard token) required for live teardown</div>
          )}

          <PreviewApply
            status={teardown.status}
            stale={teardown.stale}
            disabled={!regionList.length}
            applyDisabled={!isAdmin || tdConfirm.trim() !== 'DELETE'}
            applyNote={isAdmin ? 'type DELETE to confirm' : 'admin required'}
            onPreview={() => teardown.run(tdQs(true), true)}
            onApply={() => teardown.run(tdQs(false), false)}
            applyLabel="Tear down demo"
            busyLabel="Running…"
            destructive
            error={
              teardown.error ||
              (teardown.status === 'applied' && teardownOutcome?.kind === 'failed'
                ? `Teardown failed — 0 of ${teardownOutcome.total} template(s) succeeded.`
                : null)
            }
            message={
              teardown.status === 'previewed' ? previewMsg('Tear down demo')
                : teardown.status === 'applied' && teardownOutcome?.kind === 'partial'
                  ? `Teardown partial — ${teardownOutcome.succeeded} of ${teardownOutcome.total} succeeded, ${teardownOutcome.failed} failed.`
                : teardown.status === 'applied' && teardownOutcome?.kind === 'success' ? 'Teardown complete.'
                : null
            }
          />
        </div>
      </Card>

      {Object.keys(teardown.rows).length > 0 && (
        <Card key="provision-seed-teardown-progress" title="Teardown progress" panelId="provision-seed-teardown-progress" span={6}>
          <RowsRollup rows={teardown.rows} />
        </Card>
      )}
      {teardown.log.length > 0 && (
        <Card key="provision-seed-teardown-log" title="Teardown log" panelId="provision-seed-teardown-log" span={6}>
          <LogView log={teardown.log} doneLabel={teardown.status === 'previewed' ? 'plan complete — nothing deleted' : 'done'} />
        </Card>
      )}
      {teardownOutcome && (
        <Card key="provision-seed-teardown-summary" title={teardown.status === 'previewed' ? 'Teardown plan' : 'Teardown summary'} panelId="provision-seed-teardown-summary" span={6}>
          <div className="font-mono text-[12px]">
            Succeeded: {teardownOutcome.succeeded} · Failed: {teardownOutcome.failed} · Skipped: {teardownOutcome.skipped}
          </div>
        </Card>
      )}
    </CardGrid>
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
    <label className="flex items-center gap-2 text-body">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}
