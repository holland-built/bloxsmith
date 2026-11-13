// Site lists: put a list of websites into a security policy (owner,
// 2026-11-12). The sites come from the top sites, a CSV file or pasted text.
// Top sites compares Infoblox's InfoRank list of the most popular domains with
// this network's own busiest sites over the last 7 days, and the owner picks
// which go in (owner, 2026-11-13: "lets offer both and compare"). Sites on the
// never-add list are left out, here and again on the server. They go into a custom list, new or one
// you have, and the list goes into a policy with whichever action you pick, at
// the place in the policy's order you pick. The server previews first and
// applies only what it previewed; see go/internal/dashboard/lists.go.
import { useId, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { useWriteFlow } from '../lib/writeFlow.js'
import { compareTop, neverAdd, parseCsv, parsePasted } from '../lib/siteList.js'
import { authFetch, tokenFetch } from '../lib/authFetch.js'
import { ColumnHeading, FormColumns, ReadOnlyNote } from '../components/kit.jsx'
import { COLORS, FetchError, FIELD_CLS, PreviewApply, TabIntro } from '../components/ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import FilterSelect from '../components/FilterSelect.jsx'
import MadeList from '../components/MadeList.jsx'

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
  const never = plan.never_add_left_out
    ? ` ${plural(plan.never_add_left_out, 'site')} on the never-add list ${plan.never_add_left_out === 1 ? 'is' : 'are'} left out.`
    : ''
  const kept = list.already_there ? ` (${plural(list.already_there, 'site')} already there ${list.already_there === 1 ? 'is left as it is' : 'are left as they are'})` : ''
  const after = policy.after || []
  const newAt = policy.adds_rule ? after.findIndex((r) => r.data === list.name) : -1
  const rule = policy.adds_rule
    ? ` ${policy.name} will use it as ${actionLabel(after[newAt]?.action)}, rule ${newAt + 1} of ${after.length}.`
    : ` ${policy.name} already uses it (rule ${policy.existing_rule}), so the policy does not change.`
  return (
    <div className="flex flex-col gap-3 text-copy">
      <p>{what}{kept}.{rule}{never}</p>
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

// Which sites the Top sites choice gives, or null until both lists are in.
function topPick(tops, cmp, use) {
  if (!tops) return null
  const ir = tops.inforank.domains ?? []
  const nw = tops.network.domains ?? []
  const pick = {
    inforank: ir,
    network: nw,
    both: cmp?.both ?? [],
    either: cmp ? [...ir, ...cmp.onlyB] : [],
  }[use] ?? []
  return { domains: pick, bad: [], note: '' }
}

const USE = [
  { id: 'inforank', label: 'The most popular sites (InfoRank)' },
  { id: 'network', label: "Your network's busiest sites" },
  { id: 'both', label: 'Only sites on both lists' },
  { id: 'either', label: 'Sites on either list' },
]

// A few names, then "and N more" in a disclosure with all of them.
function Names({ title, list }) {
  return (
    <details>
      <summary className="cursor-pointer">{title}: {list.length.toLocaleString()}</summary>
      <p className="mt-1 text-note text-muted break-words">{list.length ? list.join(', ') : 'none'}</p>
    </details>
  )
}

// The two top lists compared, and the choice of which sites go in.
function TopCompare({ tops, cmp, use, onUse }) {
  const { n, inforank, network } = tops
  const day = String(inforank.date || '').slice(0, 10)
  return (
    <div className="flex flex-col gap-2 text-copy" data-top-compare="">
      <p className="text-note text-muted">
        {inforank.error
          ? `Could not get the InfoRank list: ${inforank.error}`
          : `InfoRank: the ${plural(inforank.domains.length, 'most popular site')} on the internet${day ? `, list of ${day}` : ''}.`}
        {' '}
        {network.error
          ? `Could not get your network's busiest sites: ${network.error}`
          : `Your network: the ${plural(network.domains.length, 'site')} looked up most in the last ${network.days} days${network.estimate ? ', an estimate because Infoblox sent only the 10,000 busiest names' : ''}.`}
      </p>
      {cmp && (
        <div className="flex flex-col gap-1">
          <Names title="On both lists" list={cmp.both} />
          <Names title="Only on InfoRank" list={cmp.onlyA} />
          <Names title="Only on your network" list={cmp.onlyB} />
        </div>
      )}
      <Field label={`Which of the top ${n.toLocaleString()} go in`}>
        <select className={FIELD_CLS} value={use} onChange={(e) => onUse(e.target.value)}>
          {USE.filter((u) => (u.id === 'inforank' ? !inforank.error : u.id === 'network' ? !network.error : cmp)).map((u) => (
            <option key={u.id} value={u.id}>{u.label}</option>
          ))}
        </select>
      </Field>
    </div>
  )
}

export default function SiteLists() {
  const ro = useReadOnly()
  const targets = useApi('/api/lists/targets')
  const lists = targets.data?.lists ?? []
  const policies = targets.data?.policies ?? []
  const redirects = targets.data?.redirects ?? []

  const [source, setSource] = useState('top')
  const [top, setTop] = useState(100)
  const [tops, setTops] = useState(null) // { n, inforank, network }: each { domains, ... } or { error }
  const [use, setUse] = useState('inforank')
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
  const cmp = tops?.inforank?.domains && tops?.network?.domains ? compareTop(tops.inforank.domains, tops.network.domains) : null
  const pasteParsed = source === 'paste' ? parsePasted(pasted) : null
  const ready = source === 'paste' ? pasteParsed : source === 'top' ? topPick(tops, cmp, use) : loaded

  // The never-add list: saved per tenant by the server, which leaves those
  // sites out again whatever is sent.
  const neverApi = useApi('/api/lists/never-add')
  const savedNever = neverApi.data?.sites ?? []
  const [neverText, setNeverText] = useState(null) // null until edited
  const [neverMsg, setNeverMsg] = useState(null)
  const [neverBusy, setNeverBusy] = useState(false)
  const split = neverAdd(ready?.domains ?? [], savedNever)
  const domains = split.keep

  async function saveNever() {
    const parsed = parsePasted(neverText ?? savedNever.join('\n'))
    if (parsed.bad.length) { setNeverMsg({ err: true, text: `Not a site: ${parsed.bad.slice(0, 5).join(', ')}` }); return }
    setNeverBusy(true)
    const r = await authFetch('/api/lists/never-add', { method: 'POST', body: JSON.stringify({ sites: parsed.domains }) })
    setNeverBusy(false)
    if (!r.ok) { setNeverMsg({ err: true, text: r.data?.error || `HTTP ${r.status}` }); return }
    setNeverText(null)
    setNeverMsg({ err: false, text: `Saved: ${plural(r.data.sites.length, 'site')} never to add.` })
    neverApi.refetch()
    flow.markStale()
  }

  // Each load gets a number; a reply for an older one (the source was changed,
  // or loaded again, while it was on its way) is dropped, so the sites never
  // change under a preview.
  const loadSeq = useRef(0)
  function pickSource(v) { loadSeq.current++; setSource(v); setLoaded(null); setTops(null); setLoadErr(null); setLoading(false); flow.markStale() }

  // Both lists at once. One failing still shows the other.
  function loadTop() {
    const n = Number(top)
    if (!Number.isInteger(n) || n < 1 || n > MAX) { setLoadErr(`Pick a number from 1 to ${MAX.toLocaleString()}.`); return }
    const seq = ++loadSeq.current
    setLoading(true)
    setLoadErr(null)
    setTops(null)
    flow.markStale()
    const get = (url) => authFetch(url).then((r) => (r.ok && r.data?.ok !== false ? r.data : { error: r.data?.error || `HTTP ${r.status}` }))
    Promise.all([get(`/api/lists/inforank?top=${n}`), get(`/api/lists/busiest?top=${n}`)]).then(([inforank, network]) => {
      if (seq !== loadSeq.current) return
      setTops({ n, inforank, network })
      setUse((u) => (inforank.error && !network.error ? 'network' : network.error && !inforank.error ? 'inforank' : u))
      setLoading(false)
    })
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
  // Every candidate goes to the server, which leaves out the never-add sites
  // itself and says how many in the preview.
  const body = () => ({
    domains: ready?.domains ?? [],
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
    needs: [
      domains.length === 0 && split.left.length > 0 && 'every site is on the never-add list',
      domains.length === 0 && !split.left.length && (source === 'top' ? 'press Get both lists' : source === 'csv' ? 'choose a CSV file' : 'paste some sites'),
      domains.length > MAX && `use at most ${MAX.toLocaleString()} sites`,
      !listReady && (listMode === 'new' ? 'name the new list' : 'pick a list'),
      !policyId && 'pick a policy',
    ],
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
            <Choice name="sl-source" value="top" checked={source === 'top'} onChange={pickSource}>Top sites: the most popular, and your network's busiest</Choice>
            <Choice name="sl-source" value="csv" checked={source === 'csv'} onChange={pickSource}>A CSV file</Choice>
            <Choice name="sl-source" value="paste" checked={source === 'paste'} onChange={pickSource}>Paste them in</Choice>
            <div className="pl-6 flex flex-col gap-2">
              {source === 'top' && (
                <>
                  <div className="flex items-end gap-2">
                    <Field label="How many, from the top">
                      <input {...MACHINE_TEXT} className={`${FIELD_CLS} w-32`} type="number" min="1" max={MAX} value={top}
                        onChange={(e) => { loadSeq.current++; setTop(e.target.value); setTops(null); setLoading(false); flow.markStale() }} />
                    </Field>
                    <button type="button" onClick={loadTop} disabled={loading}
                      className="px-3 py-1.5 rounded-control border text-copy"
                      style={{ borderColor: COLORS.accent, color: 'var(--color-txt)', background: 'var(--color-field)' }}>
                      {loading ? 'Getting…' : 'Get both lists'}
                    </button>
                  </div>
                  {tops && <TopCompare tops={tops} cmp={cmp} use={use} onUse={(v) => { setUse(v); flow.markStale() }} />}
                </>
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
                <p className="text-note text-muted">{ready.note || `${plural(domains.length, 'site')} ready.`}</p>
              )}
              {ready?.bad?.length > 0 && (
                <p className="text-note" style={{ color: COLORS.warn }}>
                  {plural(ready.bad.length, 'line')} {ready.bad.length === 1 ? 'is' : 'are'} not a site and will be left out: {ready.bad.slice(0, 5).join(', ')}{ready.bad.length > 5 ? ', …' : ''}
                </p>
              )}
            </div>
          </fieldset>

          <div className="flex flex-col gap-2">
            <Field label="Sites never to add, one per line (kept for this tenant)">
              <textarea {...MACHINE_TEXT} className={FIELD_CLS} rows={3} value={neverText ?? savedNever.join('\n')}
                onChange={(e) => { setNeverText(e.target.value); setNeverMsg(null) }} placeholder="example.com" />
            </Field>
            <div className="flex items-center gap-3">
              <button type="button" onClick={saveNever} disabled={neverBusy || neverText === null}
                className="px-3 py-1.5 rounded-control border text-copy"
                style={{ borderColor: COLORS.accent, color: 'var(--color-txt)', background: 'var(--color-field)' }}>
                {neverBusy ? 'Saving…' : 'Save never-add list'}
              </button>
              {neverMsg && <span role={neverMsg.err ? 'alert' : 'status'} className="text-note" style={{ color: neverMsg.err ? COLORS.crit : undefined }}>{neverMsg.text}</span>}
            </div>
            {split.left.length > 0 && (
              <p className="text-note text-muted">
                {plural(split.left.length, 'site')} on the never-add list will be left out: {split.left.slice(0, 5).join(', ')}{split.left.length > 5 ? ', …' : ''}
              </p>
            )}
            <FetchError error={neverApi.error} />
          </div>

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
      <section className="mt-8" aria-labelledby="lists-made-h">
        <ColumnHeading id="lists-made-h">Lists and rules made here</ColumnHeading>
        <p className="text-note text-muted mb-2">Newest first. Delete a rule before its list. Each delete asks first.</p>
        <MadeList sources={['lists']} ro={ro.readOnly} empty="Nothing made here yet." />
      </section>
    </div>
  )
}
