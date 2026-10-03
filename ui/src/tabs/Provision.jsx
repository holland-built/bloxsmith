import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
// FetchError is the same shared component SelfService.jsx uses. /api/ipam/spaces
// and /api/ipam/blocks answer 502 on an upstream failure and /api/templates
// answers 500 — and `data?.spaces ?? []` collapses every one of those into the
// empty array a tenant that genuinely owns nothing produces. Unread, the select
// falls back to its placeholder and Apply sits disabled with no reason given.
import { Card, CardGrid, COLORS, Empty, FetchError, FIELD_CLS, PreviewApply, TabIntro } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'
import { PageRail } from '../components/kit.jsx'
import { dhcpSkips } from '../lib/dhcpSkips.js'
import { authFetch, withToken } from '../lib/authFetch.js'
import { templateScanErrors } from '../lib/templateScanErrors.js'

const inputCls = `${FIELD_CLS} w-full`

// ---------- write permission ----------
//
// Apply changes the customer's tenant, and the server refuses it unless that
// tenant has been marked writable (go/internal/server/writelock.go). Preview is
// a dry run that changes nothing, so the lock lets it through on a read-only
// tenant. EventSource cannot read a refusal's body, so without this an Apply on
// a read-only tenant only ever said "Stream connection error". The page now
// reads the same /api/vault/write-target the Settings panel reads, says up
// front when the tenant is read-only, and offers the same switch.
//
// Three outcomes stay distinct, as in Settings: writable, read-only, and "could
// not tell where a write would land". The last is not read-only; it is unknown.
const WriteTarget = createContext(null)

function useWriteTarget() {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const load = useCallback(async () => {
    const r = await authFetch('/api/vault/write-target', { cache: 'no-store' })
    if (r.ok && r.data) setState({ loading: false, data: r.data, error: null })
    else setState((prev) => ({ loading: false, data: prev.data, error: 'Could not read whether this tenant allows changes.' }))
  }, [])
  useEffect(() => { load() }, [load])
  const d = state.data
  const readOnly = !!(d && d.known && d.writable === false)
  const name = d?.label || d?.tenant || 'This tenant'
  return { ...state, readOnly, name, reload: load }
}

function WriteAccessBanner({ isAdmin }) {
  const wt = useContext(WriteTarget)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!wt || wt.loading) return null
  if (wt.error && !wt.data) return <div className="mb-4 text-note" style={{ color: COLORS.warn }}>{wt.error}</div>
  if (wt.data && !wt.data.known) {
    return (
      <div className="mb-4 text-note" style={{ color: COLORS.warn }}>
        Could not tell which tenant a change would land in, so Apply will be refused: {wt.data.reason}
      </div>
    )
  }
  if (!wt.readOnly) return null

  // The id of the tenant NAMED on screen is sent, not left for the server to
  // resolve: the active tenant is process-wide, and another tab could switch it
  // while this confirm is open. Without the id the server would mark whichever
  // tenant is active by then, not the one the operator just agreed to.
  const allow = async () => {
    setBusy(true); setErr('')
    const r = await authFetch('/api/vault/tenant-writable', { method: 'POST', body: JSON.stringify({ writable: true, id: wt.data.tenant }) })
    setBusy(false)
    if (r.ok && r.data?.ok) {
      setConfirming(false)
      wt.reload()
      // The tenant chip in the top bar shows this same permission.
      window.dispatchEvent(new Event('bx:write-target'))
    }
    else setErr(r.data?.error || 'Could not change the write permission.')
  }

  return (
    <div role="status" className="mb-4 rounded-control border px-3 py-2.5 text-copy" style={{ borderColor: 'var(--color-warn)' }}>
      <p>
        <strong>{wt.name} is read-only.</strong> Preview works, because it changes nothing. Apply is off until the tenant is switched to read-write.
      </p>
      {!isAdmin ? (
        <p className="text-note text-muted mt-1">An admin can switch it to read-write in Settings.</p>
      ) : !confirming ? (
        <button type="button" onClick={() => setConfirming(true)}
          className="mt-2 px-2.5 py-1.5 rounded-control border border-border text-copy hover:border-border-hover">
          Switch to read-write
        </button>
      ) : (
        <div className="mt-2">
          <p className="text-note mb-2" style={{ color: 'var(--color-warn)' }}>
            This lets Apply and teardown create and delete real DNS zones, subnets, address blocks, DHCP ranges and
            host records in {wt.name}.
            Only do this on a tenant you own. You can switch it back in Settings.
          </p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={allow}
              className="px-2.5 py-1.5 rounded-control border text-copy disabled:opacity-50"
              style={{ borderColor: 'var(--color-crit)', color: 'var(--color-crit)' }}>
              {busy ? 'Saving…' : 'Yes, allow changes'}
            </button>
            <button type="button" disabled={busy} onClick={() => { setConfirming(false); setErr('') }}
              className="px-2.5 py-1.5 rounded-control border border-border text-copy">
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="text-note mt-2" style={{ color: 'var(--color-crit)' }}>{err}</p>}
    </div>
  )
}

// useRole reads /api/whoami through authFetch, not useApi. The server answers
// "admin" only when X-Auth-Token matches DASHBOARD_TOKEN, and useApi sends no
// token, so on a token deployment an admin read as "viewer" and lost the admin
// controls. It reads again when the token changes in Settings (the sheet opens
// over this tab), and retries a failed read instead of staying "viewer".
function useRole() {
  const [role, setRole] = useState('viewer')
  useEffect(() => {
    let alive = true
    let seq = 0
    let timer
    const load = async () => {
      clearTimeout(timer)
      const mine = ++seq
      const r = await authFetch('/api/whoami', { cache: 'no-store' })
      // A token typed one key at a time fires one read per key; keep the newest.
      if (!alive || mine !== seq) return
      if (r.ok && r.data?.role) setRole(r.data.role)
      else timer = setTimeout(load, 5000)
    }
    load()
    window.addEventListener('bx:token-changed', load)
    return () => {
      alive = false
      clearTimeout(timer)
      window.removeEventListener('bx:token-changed', load)
    }
  }, [])
  return role
}

export default function Provision() {
  const [mode, setMode] = useState('subnet') // 'subnet' | 'site' | 'seed'
  const role = useRole()
  const isAdmin = role === 'admin'
  const writeTarget = useWriteTarget()

  return (
    <WriteTarget.Provider value={writeTarget}>
    <PageRail>
    <div className="max-w-[820px] p-5">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-copy font-semibold tracking-tight">Provision</h1>
        <span
          className="text-note font-medium px-2 py-0.5 rounded-full"
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

      <WriteAccessBanner isAdmin={isAdmin} />

      <div className="flex gap-1 mb-4 p-1 rounded-control bg-field border border-border w-fit">
        {[
          ['subnet', 'Subnet'],
          ['site', 'Full site'],
          ['seed', 'Seed demo'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            aria-pressed={mode === key}
            className={`px-3 py-1.5 rounded-control text-copy font-medium ${
              mode === key ? 'bg-accent text-on-accent' : 'text-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'subnet' ? <SubnetMode /> : mode === 'site' ? <SiteMode isAdmin={isAdmin} /> : <SeedMode isAdmin={isAdmin} />}
    </div>
    </PageRail>
    </WriteTarget.Provider>
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
  const writeTarget = useContext(WriteTarget)

  useEffect(() => () => esRef.current?.close(), [])

  function markStale() {
    if (status === 'previewed') setStale(true)
  }

  function run(qs, dry) {
    if (status === 'busy' || esRef.current) return
    // A read-only tenant refuses an Apply before it starts, and the browser
    // hides the reason. Say it instead of opening a stream. A Preview (dry run)
    // is let through by the server, so it is not stopped here.
    if (!dry && writeTarget?.readOnly) {
      setError(`${writeTarget.name} is read-only, so nothing was sent. Switch it to read-write at the top of this page.`)
      return
    }
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
    es.onerror = () => {
      if (!esRef.current) return
      setError((p) => p || 'The server closed the connection before sending anything. If this tenant was just made read-only, the notice at the top of this page says so.')
      stop('idle')
      // The permission may have changed since the page loaded; re-read it so
      // the notice at the top reflects what the server just enforced.
      writeTarget?.reload()
    }
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
      <div role="alert" className="flex flex-col gap-0.5">
        <div className="text-copy font-semibold" style={{ color: COLORS.crit }}>
          Cleanup could not remove {residual.length || attempted - deleted} object
          {(residual.length || attempted - deleted) === 1 ? '' : 's'} — they are still live on the customer&rsquo;s
          network
        </div>
        <div className="text-note text-dim mb-1">{deleted} of {attempted} removed</div>
        {residual.map((o, i) => (
          <div key={o?.id || i} className="font-mono text-note" style={{ color: COLORS.crit }}>
            ✕ {o?.kind || 'object'}{' '}
            <code className="font-mono text-note px-1 py-0.5 rounded-mark bg-field">{o?.label || o?.id || '—'}</code>
            {o?.status ? <span className="text-dim"> (HTTP {o.status})</span> : null}
          </div>
        ))}
      </div>
    )
  }
  if (report.outcome === 'complete') {
    return (
      <div className="text-note text-dim">
        Cleanup removed all {deleted} object{deleted === 1 ? '' : 's'} it had created — nothing was left behind.
      </div>
    )
  }
  if (report.outcome === 'not_needed') {
    return <div className="text-note text-dim">Nothing had been created, so nothing needed removing.</div>
  }
  return null
}

// ---------- log rendering ----------

function LogView({ log, doneLabel }) {
  if (log.length === 0) return <Empty>Output appears here when you preview or apply.</Empty>
  return (
    <div role="log" aria-live="polite" tabIndex={0} aria-label="Run output" className="font-mono text-note flex flex-col gap-0.5 max-h-[280px] overflow-auto">
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
      <div className="font-mono text-note" style={{ color: failed ? 'var(--color-crit)' : 'var(--color-muted)' }}>
        {done}/{total} done{failed ? ` · ${failed} ${failedLabel || 'failed'}` : ''}
      </div>
      {Object.entries(rows).filter(([, r]) => r?.error).map(([tpl, r]) => (
        <div key={tpl} className="font-mono text-note" style={{ color: COLORS.crit }}>
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
        <div data-form-cols="" className="flex flex-col gap-3">
          <Field group label="Space">
            <FilterSelect
              label="Space"
              value={space}
              onChange={(v) => { setSpace(v); setBlock(''); flow.markStale() }}
              placeholder={spacesApi.loading ? 'Loading spaces…' : 'Select a space'}
              options={spaces.map((sp) => ({ value: sp.id, label: sp.name }))}
            />
          </Field>
          <Field group label="Block">
            {/* Keyed on the space, so a search typed for one space's blocks is
                cleared when the space changes. Disabled while the new space's
                blocks load, and after that load fails: useApi keeps the last
                list it had, which can be the previous space's, so it stays on
                screen under the "may be out of date" warning but cannot be
                picked from. */}
            <FilterSelect
              key={space}
              label="Block"
              value={block}
              onChange={(v) => { setBlock(v); flow.markStale() }}
              disabled={!space || blocksApi.loading || !!blocksApi.error}
              placeholder={!space ? 'Pick a space first' : blocksApi.loading ? 'Loading blocks…' : 'Select a block'}
              options={blocks.map((b) => ({ value: b.id, label: b.name || b.cidr || b.address }))}
            />
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
          <div className="font-mono text-note">
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
        <div data-form-cols="" className="flex flex-col gap-3">
          <Field group label="IP space (override)">
            <FilterSelect
              label="IP space"
              value={siteSpace}
              onChange={(v) => onInput(setSiteSpace)(v)}
              placeholder="— template default —"
              options={spaces.map((sp) => ({ value: sp.name, label: sp.name }))}
            />
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
              <div className="text-note text-muted">Could not be read:</div>
              {templateScanErrors(templates).map((s) => (
                <div key={s.key} className="font-mono text-note" style={{ color: COLORS.crit }}>
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
              <div key={s.key} className="font-mono text-note" style={{ color: COLORS.crit }}>
                ✕ {s.name}{s.subnet ? ` on ${s.subnet}` : ''}{s.range ? ` (${s.range})` : ''} — {s.reason}
              </div>
            ))}
          </div>
        </Card>
      )}

      {build.status === 'applied' && built && (
        <Card key="provision-site-result" title="Result" panelId="provision-site-result" span={6}>
          {built.skipped ? (
            <div className="font-mono text-note text-muted">Skipped — {built.skip_reason || 'already provisioned'}.</div>
          ) : (
            <div className="font-mono text-note flex flex-col gap-0.5">
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
        <div data-form-cols="" className="flex flex-col gap-3">
          {isAdmin ? (
            <Field label="Type the site name to confirm">
              <input className={inputCls} value={tdConfirm} onChange={(e) => { setTdConfirm(e.target.value); teardown.markStale() }} placeholder={siteTemplate || 'site name'} />
            </Field>
          ) : (
            <div className="text-note" style={{ color: COLORS.warn }}>Admin (dashboard token) required for live teardown</div>
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
          <div className="font-mono text-note flex flex-col gap-0.5">
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
        <div className="text-note text-dim mb-3">
          Provisions a full set of demo sites, subnets, and zones across the selected regions from the template
          library. Preview the plan before writing real objects — this creates a lot of them.
        </div>
        <div data-form-cols="" className="flex flex-col gap-3">
          {['amer', 'emea', 'apac'].map((r) => (
            <CheckRow
              key={r}
              checked={!!regions[r]}
              onChange={(v) => { setRegions((prev) => ({ ...prev, [r]: v })); touch() }}
              label={r.toUpperCase()}
            />
          ))}
          <Field group label="IP space (override)">
            <FilterSelect
              label="IP space"
              value={seedSpace}
              onChange={(v) => { setSeedSpace(v); touch() }}
              placeholder="— template default —"
              options={spaces.map((sp) => ({ value: sp.name, label: sp.name }))}
            />
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
          <div className="font-mono text-note">
            Succeeded: {seedOutcome.succeeded} · Failed: {seedOutcome.failed} · Skipped: {seedOutcome.skipped}
          </div>
        </Card>
      )}

      <Card key="provision-seed-teardown" title="Tear down demo" note={`permanently deletes every seed-created object in ${seedSpace || 'the default space'}`} panelId="provision-seed-teardown" span={6}>
        <div data-form-cols="" className="flex flex-col gap-3">
          {isAdmin ? (
            <Field label="Type DELETE to confirm">
              <input className={inputCls} value={tdConfirm} onChange={(e) => { setTdConfirm(e.target.value); teardown.markStale() }} placeholder="DELETE" />
            </Field>
          ) : (
            <div className="text-note" style={{ color: COLORS.warn }}>Admin (dashboard token) required for live teardown</div>
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
          <div className="font-mono text-note">
            Succeeded: {teardownOutcome.succeeded} · Failed: {teardownOutcome.failed} · Skipped: {teardownOutcome.skipped}
          </div>
        </Card>
      )}
    </CardGrid>
  )
}

// ---------- shared form bits ----------

const RESULTS_CAP = 50

// A dropdown with a search box above it. A tenant can have hundreds of IP
// spaces (801 on the live one, 2026-09-25), which made the plain list a long
// scroll. Typing narrows the options; the list itself stays a native <select>,
// so keyboard use and screen readers work as they did.
//
// The chosen option always stays in the list, even when the search no longer
// matches it, so narrowing the search never silently changes the selection.
function FilterSelect({ label, value, onChange, options, placeholder, disabled }) {
  const [q, setQ] = useState('')
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const needle = q.trim().toLowerCase()
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options
  const chosen = value && !shown.some((o) => o.value === value) ? options.find((o) => o.value === value) : null
  // The matches, shown as you type so nobody has to open the dropdown to see
  // them. Capped for the page's sake; the dropdown below still holds every match.
  const results = needle && !disabled ? shown.slice(0, RESULTS_CAP) : []
  const pick = (v) => {
    onChange(v)
    setQ('')
    // The list goes away with the search, so focus goes back to the box rather
    // than falling to the page.
    inputRef.current?.focus()
  }
  const buttons = () => [...(listRef.current?.querySelectorAll('button') ?? [])]
  const clear = () => { setQ(''); inputRef.current?.focus() }
  const onListKey = (e) => {
    const all = buttons()
    const i = all.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); all[Math.min(i + 1, all.length - 1)]?.focus() }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (i <= 0) inputRef.current?.focus()
      else all[i - 1].focus()
    }
    else if (e.key === 'Escape') { e.preventDefault(); clear() }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={inputRef}
        type="search"
        aria-label={`Search ${label}`}
        placeholder={`Type to search ${options.length.toLocaleString()} ${options.length === 1 ? 'option' : 'options'}`}
        className={inputCls}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); buttons()[0]?.focus() }
          else if (e.key === 'Enter') { e.preventDefault(); if (results.length) pick(results[0].value) }
          else if (e.key === 'Escape' && q) { e.preventDefault(); clear() }
        }}
        disabled={disabled || options.length === 0}
      />
      {results.length > 0 && (
        <ul ref={listRef} aria-label={`Matching ${label.toLowerCase()}`} onKeyDown={onListKey} className="flex flex-col max-h-[240px] overflow-y-auto rounded-control border border-border bg-field">
          {results.map((o, i) => (
            <li key={`${i}:${o.value}`}>
              <button
                type="button"
                onClick={() => pick(o.value)}
                aria-current={o.value === value ? 'true' : undefined}
                className={`w-full text-left text-copy px-3 py-1.5 hover:bg-line focus-visible:bg-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${o.value === value ? 'font-semibold text-txt' : 'text-field-txt'}`}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Said out loud as the matches change, since a list appearing is silent.
          Kept in the page with no search, only hidden, because a live region
          that appears already holding its text is announced unreliably. */}
      <span role="status" className={needle ? 'text-note text-dim' : 'sr-only'}>
        {!needle ? '' : shown.length === 0
          ? `No ${label.toLowerCase()} matches “${q.trim()}”.`
          : shown.length > RESULTS_CAP
            ? `Showing ${RESULTS_CAP} of ${shown.length.toLocaleString()} matches. Keep typing to narrow it, or use the list below.`
            : `${shown.length.toLocaleString()} ${shown.length === 1 ? 'match' : 'matches'}.`}
      </span>
      <select aria-label={label} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{needle ? `${placeholder} (${shown.length.toLocaleString()} of ${options.length.toLocaleString()} match)` : placeholder}</option>
        {chosen && <option value={chosen.value}>{chosen.label}</option>}
        {/* Index in the key: two spaces can share a name, and the site and seed
            pickers use the name as the value. */}
        {shown.map((o, i) => <option key={`${i}:${o.value}`} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

// A form row. On a screen md and wider, [data-form-cols] in index.css puts the
// caption in a left column and the control beside it. A search box plus its
// dropdown is two controls, so that row is a named group rather than one
// <label> wrapped around both.
function Field({ label, group = false, children }) {
  const id = useId()
  const cls = 'flex flex-col gap-1 text-note text-muted'
  return group ? (
    <div role="group" aria-labelledby={id} data-field="" className={cls}>
      <span id={id}>{label}</span>
      {children}
    </div>
  ) : (
    <label data-field="" className={cls}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function CheckRow({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 text-copy">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}
