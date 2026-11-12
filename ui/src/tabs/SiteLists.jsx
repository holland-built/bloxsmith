// Site lists: put a list of websites into a security policy (owner,
// 2026-11-12). The sites come from Infoblox's InfoRank list of the most popular
// domains, a CSV file or pasted text. They go into a custom list, new or one
// you have, and the list goes into a policy with whichever action you pick, at
// the place in the policy's order you pick. The server previews first and
// applies only what it previewed; see go/internal/dashboard/lists.go.
import { useId, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { useWriteFlow } from '../lib/writeFlow.js'
import { parseCsv, parsePasted } from '../lib/siteList.js'
import { tokenFetch } from '../lib/authFetch.js'
import { ColumnHeading, FormColumns, ReadOnlyNote } from '../components/kit.jsx'
import { COLORS, FetchError, FIELD_CLS, PreviewApply, TabIntro } from '../components/ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import FilterSelect from '../components/FilterSelect.jsx'

// The six actions a policy takes for a list, in the order people reach for
// them, each with what it means for someone visiting one of the sites.
const ACTIONS = [
  { id: 'action_block', label: 'Block', says: 'People cannot reach these sites. Each attempt is logged.' },
  { id: 'action_allow', label: 'Allow', says: 'These sites are always allowed, even if a feed lower down would block them.' },
  { id: 'action_log', label: 'Log only', says: 'Nothing is blocked. Each visit is logged so you can see who goes there.' },
  { id: 'action_redirect', label: 'Redirect', says: 'People are sent to a block page instead. Each attempt is logged.' },
  { id: 'action_block_nolog', label: 'Block without logging', says: 'People cannot reach these sites, and nothing is logged.' },
  { id: 'action_redirect_nolog', label: 'Redirect without logging', says: 'People are sent to a block page, and nothing is logged.' },
]
const actionLabel = (id) => ACTIONS.find((a) => a.id === id)?.label || id
const MAX = 50000

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

function Choice({ name, value, checked, onChange, children }) {
  return (
    <label className="flex items-center gap-2 text-copy">
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} />
      {children}
    </label>
  )
}

// What a rule is, in words: "custom list vip, Allow".
const ruleWords = (r) => `${r.data}${r.type === 'custom_list' ? '' : ` (${String(r.type).replace(/_/g, ' ')})`}, ${actionLabel(r.action)}`

function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

// The preview, as sentences and the policy's rule order after the change.
function PlanView({ plan }) {
  const { list, policy, sample } = plan
  const added = list.will_add
  const what = list.new
    ? `This will make a new list, ${list.name}, with ${plural(added, 'site')}`
    : added
      ? `This will add ${plural(added, 'site')} to ${list.name}`
      : `Every site is already in ${list.name}, so the list stays as it is`
  const kept = list.already_there ? ` (${plural(list.already_there, 'site')} already there ${list.already_there === 1 ? 'is left as it is' : 'are left as they are'})` : ''
  const after = policy.after || []
  const newAt = policy.adds_rule ? after.findIndex((r) => r.data === list.name) : -1
  const rule = policy.adds_rule
    ? ` ${policy.name} will use it as ${actionLabel(after[newAt]?.action)}, rule ${newAt + 1} of ${after.length}.`
    : ` ${policy.name} already uses it (rule ${policy.existing_rule}), so the policy does not change.`
  return (
    <div className="flex flex-col gap-3 text-copy">
      <p>{what}{kept}.{rule}</p>
      {list.also_used_by?.length > 0 && (
        <p role="note" className="rounded-control px-3 py-2" style={{ background: 'var(--pill-warn-bg)', color: 'var(--pill-warn-fg)' }}>
          {list.name} is also used by {list.also_used_by.join(', ')}. The new sites take effect there too.
        </p>
      )}
      <div>
        <h3 className="text-copy font-semibold mb-1">{policy.name}: rules, checked from the top</h3>
        <ol className="flex flex-col gap-0.5 list-decimal pl-6">
          {after.map((r, i) => (
            <li key={i} style={i === newAt ? { color: 'var(--color-txt)', fontWeight: 600 } : { color: 'var(--color-muted)' }}>
              {ruleWords(r)}{i === newAt && ' (new)'}
            </li>
          ))}
        </ol>
      </div>
      {sample?.length > 0 && (
        <details>
          <summary className="cursor-pointer">The first {plural(sample.length, 'site')} to be added</summary>
          <p className="mt-1 text-note text-muted break-words">{sample.join(', ')}</p>
        </details>
      )}
    </div>
  )
}

function doneMsg(j) {
  const l = j.list || {}
  const p = j.policy || {}
  const added = j.steps?.list?.added ?? l.will_add ?? 0
  if (j.nothing_to_do) return `Nothing to change: every site is already in ${l.name}, and ${p.name} already uses it.`
  const rule = p.adds_rule ? `, and ${p.name} now uses it (rule ${j.steps?.policy?.position})` : ''
  return `Done. ${l.name} gained ${plural(added, 'site')}${rule}.`
}

export default function SiteLists() {
  const ro = useReadOnly()
  const targets = useApi('/api/lists/targets')
  const lists = targets.data?.lists ?? []
  const policies = targets.data?.policies ?? []
  const redirects = targets.data?.redirects ?? []

  const [source, setSource] = useState('inforank')
  const [top, setTop] = useState(100)
  const [loaded, setLoaded] = useState(null) // { domains, bad, note }
  const [loadErr, setLoadErr] = useState(null)
  const [loading, setLoading] = useState(false)
  const [pasted, setPasted] = useState('')

  const [listMode, setListMode] = useState('new')
  const [listName, setListName] = useState('')
  const [listId, setListId] = useState('')
  const [policyId, setPolicyId] = useState('')
  const [action, setAction] = useState('action_block')
  const [redirect, setRedirect] = useState('')
  const [position, setPosition] = useState('0')

  const flow = useWriteFlow('/api/lists/apply')
  const edit = (set) => (v) => { set(v); flow.markStale() }

  const policy = policies.find((p) => String(p.id) === policyId)
  const rules = policy?.rules ?? []
  const pasteParsed = source === 'paste' ? parsePasted(pasted) : null
  const ready = source === 'paste' ? pasteParsed : loaded
  const domains = ready?.domains ?? []

  // Each load gets a number; a reply for an older one (the source was changed,
  // or loaded again, while it was on its way) is dropped, so the sites never
  // change under a preview.
  const loadSeq = useRef(0)
  function pickSource(v) { loadSeq.current++; setSource(v); setLoaded(null); setLoadErr(null); setLoading(false); flow.markStale() }

  function loadTop() {
    const n = Number(top)
    if (!Number.isInteger(n) || n < 1 || n > MAX) { setLoadErr(`Pick a number from 1 to ${MAX.toLocaleString()}.`); return }
    const seq = ++loadSeq.current
    setLoading(true)
    setLoadErr(null)
    flow.markStale()
    tokenFetch(`/api/lists/inforank?top=${n}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (seq !== loadSeq.current) return
        if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`)
        const day = String(j.date || '').slice(0, 10)
        setLoaded({ domains: j.domains, bad: [], note: `The ${plural(j.domains.length, 'most popular site')} from Infoblox's InfoRank list${day ? ` of ${day}` : ''}.` })
      })
      .catch((e) => { if (seq === loadSeq.current) { setLoaded(null); setLoadErr(`Could not get the InfoRank list: ${e.message}`) } })
      .finally(() => { if (seq === loadSeq.current) setLoading(false) })
  }

  function loadFile(file) {
    const seq = ++loadSeq.current
    setLoadErr(null)
    flow.markStale()
    if (!file) { setLoaded(null); return }
    file.text().then((t) => {
      if (seq !== loadSeq.current) return
      const r = parseCsv(t)
      if (r.domains.length > MAX) { setLoaded(null); setLoadErr(`That file has ${r.domains.length.toLocaleString()} sites; the most at once is ${MAX.toLocaleString()}.`); return }
      setLoaded({ ...r, note: `${plural(r.domains.length, 'site')} from ${file.name}.` })
    }, () => setLoadErr('That file could not be read.'))
  }

  const isRedirect = action.startsWith('action_redirect')
  const listReady = listMode === 'new' ? listName.trim() !== '' : listId !== ''
  const body = () => ({
    domains,
    list: listMode === 'new' ? { name: listName.trim() } : { id: Number(listId) },
    policy_id: Number(policyId),
    action,
    ...(isRedirect ? { redirect_name: redirect } : {}),
    position: Number(position),
    fingerprint: flow.stale ? undefined : flow.previewReply?.fingerprint,
  })

  const applyProps = {
    status: flow.status,
    stale: flow.stale,
    disabled: domains.length === 0 || domains.length > MAX || !listReady || !policyId,
    onPreview: () => flow.runPreview(body(), 'Add to policy'),
    onApply: () => flow.runApply(body(), doneMsg),
    applyLabel: 'Add to policy',
    error: flow.error,
    message: flow.message,
  }

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-copy font-semibold tracking-tight mb-1">Site lists</h1>
      <TabIntro>Put a list of websites into a security policy, to block, allow, log or redirect them.</TabIntro>
      <ReadOnlyNote ro={ro} what="Preview works, because it changes nothing. Add to policy is off." />
      <FormColumns form={
        <section aria-labelledby="sl-form-h" className="flex flex-col gap-5">
          <ColumnHeading id="sl-form-h">Make the list</ColumnHeading>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-note text-muted mb-1">Where the sites come from</legend>
            <Choice name="sl-source" value="inforank" checked={source === 'inforank'} onChange={pickSource}>Most popular sites (Infoblox InfoRank)</Choice>
            <Choice name="sl-source" value="csv" checked={source === 'csv'} onChange={pickSource}>A CSV file</Choice>
            <Choice name="sl-source" value="paste" checked={source === 'paste'} onChange={pickSource}>Paste them in</Choice>
            <div className="pl-6 flex flex-col gap-2">
              {source === 'inforank' && (
                <div className="flex items-end gap-2">
                  <Field label="How many, from the top">
                    <input {...MACHINE_TEXT} className={`${FIELD_CLS} w-32`} type="number" min="1" max={MAX} value={top}
                      onChange={(e) => { setTop(e.target.value); setLoaded(null); flow.markStale() }} />
                  </Field>
                  <button type="button" onClick={loadTop} disabled={loading}
                    className="px-3 py-1.5 rounded-control border text-copy"
                    style={{ borderColor: COLORS.accent, color: 'var(--color-txt)', background: 'var(--color-field)' }}>
                    {loading ? 'Getting…' : 'Get the list'}
                  </button>
                </div>
              )}
              {source === 'csv' && (
                <Field label="CSV file: one site per row, in the first column">
                  <input type="file" accept=".csv,.txt,text/csv,text/plain" className="text-copy" onChange={(e) => loadFile(e.target.files?.[0])} />
                </Field>
              )}
              {source === 'paste' && (
                <Field label="One site per line, or separated by commas">
                  <textarea {...MACHINE_TEXT} className={FIELD_CLS} rows={6} value={pasted}
                    onChange={(e) => { setPasted(e.target.value); flow.markStale() }} placeholder={'example.com\nexample.org'} />
                </Field>
              )}
              {loadErr && <p role="alert" className="text-note" style={{ color: COLORS.crit }}>{loadErr}</p>}
              {ready && (ready.note || ready.domains.length > 0) && (
                <p className="text-note text-muted">{ready.note || `${plural(ready.domains.length, 'site')} ready.`}</p>
              )}
              {ready?.bad?.length > 0 && (
                <p className="text-note" style={{ color: COLORS.warn }}>
                  {plural(ready.bad.length, 'line')} {ready.bad.length === 1 ? 'is' : 'are'} not a site and will be left out: {ready.bad.slice(0, 5).join(', ')}{ready.bad.length > 5 ? ', …' : ''}
                </p>
              )}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-note text-muted mb-1">The list they go into</legend>
            <Choice name="sl-list" value="new" checked={listMode === 'new'} onChange={edit(setListMode)}>Make a new list</Choice>
            <Choice name="sl-list" value="existing" checked={listMode === 'existing'} onChange={edit(setListMode)}>Add to a list I have</Choice>
            <div className="pl-6">
              {listMode === 'new' ? (
                <Field label="New list name">
                  <input {...MACHINE_TEXT} className={FIELD_CLS} value={listName} onChange={(e) => edit(setListName)(e.target.value)} placeholder="top-sites" />
                </Field>
              ) : (
                <Field label="List" group>
                  <FilterSelect label="List" value={listId} onChange={edit(setListId)} placeholder="Select list…"
                    options={lists.map((l) => ({ value: String(l.id), label: `${l.name} (${plural(l.item_count ?? 0, 'site')})` }))} />
                </Field>
              )}
            </div>
          </fieldset>

          <Field label="Policy" group>
            <FilterSelect label="Policy" value={policyId} placeholder="Select policy…"
              onChange={(v) => { setPolicyId(v); setPosition('0'); flow.markStale() }}
              options={policies.map((p) => ({ value: String(p.id), label: p.name }))} />
          </Field>

          <div className="flex flex-col gap-1">
            <Field label="What the policy does with these sites">
              <select className={FIELD_CLS} value={action} aria-describedby="sl-action-says" onChange={(e) => edit(setAction)(e.target.value)}>
                {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Field>
            <span id="sl-action-says" className="text-note text-muted">{ACTIONS.find((a) => a.id === action)?.says}</span>
          </div>

          {isRedirect && (
            <Field label="Block page">
              <select className={FIELD_CLS} value={redirect} onChange={(e) => edit(setRedirect)(e.target.value)}>
                <option value="">Infoblox block page</option>
                {redirects.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
          )}

          <Field label="Where the rule goes (rules are checked from the top)">
            <select className={FIELD_CLS} value={position} disabled={!policy} onChange={(e) => edit(setPosition)(e.target.value)}>
              <option value="0">First, before every other rule</option>
              {rules.map((r, i) => <option key={i} value={String(i + 1)}>After rule {i + 1}: {ruleWords(r)}</option>)}
            </select>
          </Field>

          <PreviewApply {...applyProps} part="start" />
          <FetchError error={targets.error} stale={policies.length > 0} />
        </section>
      } result={
        <section aria-labelledby="sl-result-h" data-result-of="lists">
          <ColumnHeading id="sl-result-h">Preview</ColumnHeading>
          <PreviewApply {...applyProps} part="outcome">
            {flow.previewReply && flow.status === 'previewed'
              ? <PlanView plan={flow.previewReply} />
              : !flow.message && <p className="text-copy text-muted">Pick the sites, the list and the policy, then press Preview. Nothing changes in Infoblox until you press Add to policy.</p>}
          </PreviewApply>
        </section>
      } />
    </div>
  )
}
