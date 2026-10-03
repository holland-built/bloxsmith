import { useEffect, useRef, useState } from 'react'
import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, TabIntro } from '../components/ui.jsx'
import { authFetch } from '../lib/authFetch.js'
import DossierPanel from '../components/DossierPanel.jsx'
import { dossierHasVerdict } from '../lib/dossierVerdict.js'

const inputCls = 'px-2.5 py-1.5 rounded-control border border-border bg-field text-field-txt'

const SUGGESTIONS = [
  'Which subnets are nearly full?',
  'Which domains are on threat feeds?',
  'Any lookalike domains of my brand?',
  'Are any of my DNS zones misconfigured?',
  'Which hosts are offline?',
  'What changed in the last 24 hours?',
]

// ---------- chat ----------

function Message({ item }) {
  if (item.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] px-3 py-2 rounded-control bg-line-2 text-txt text-copy">{item.text}</div>
      </div>
    )
  }
  if (item.error) {
    return (
      <div className="flex justify-start">
        <div
          className="max-w-[85%] px-3 py-2 rounded-control border text-copy"
          style={{ borderColor: 'var(--color-crit)', background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)' }}
        >
          {item.error}
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-3 py-2 rounded-control border border-border bg-field text-field-txt text-copy whitespace-pre-wrap">
        {/* Said on every answer, so model prose is never read as a measured
            figure. The facts under it are the server's, and say so. */}
        <p className="text-note text-muted mb-1">AI-generated</p>
        {item.text}
        {!!(item.suggestions && item.suggestions.length) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {item.suggestions.map((sg, i) => (
              <span key={i} className="text-note px-2 py-0.5 rounded-control border border-border text-muted">{sg}</span>
            ))}
          </div>
        )}
        {!!(item.trace && item.trace.length) && (
          <div className="mt-2 pt-2 border-t border-border font-mono text-note text-muted space-y-0.5">
            {item.trace.map((t, i) => (
              <div key={i}>
                <span>{t.tool}</span> <span className="opacity-70">{JSON.stringify(t.args)}</span>
                {/* `fact` is counted by the server from the rows themselves, not
                    written by the model. Text inside the tenant's own data can
                    steer the prose above (demonstrated: a hostname carrying an
                    injected instruction made the model report "all hosts are
                    online" while holding data showing one offline). It cannot
                    change this line, so an answer that contradicts it is visibly
                    contradicted. */}
                {t.fact ? <div className="opacity-90 not-italic">↳ {t.fact}</div> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// BudgetLine is the whole point of this feature, so its rules are literal:
//   1. No "limit_tokens" in the response -> no denominator, no percent, no bar.
//      We do not know the provider's cap, so we say only what we counted.
//   2. The count is what THIS server counted, never the account's true usage —
//      the same key used elsewhere is invisible to us. Said in plain text, not
//      buried in a tooltip.
//   3. "near_limit" true -> a warning that answers are about to stop, as text
//      (not colour alone) so it survives screen readers and colour-blindness.
//   4. No "budget" object at all on a response -> render nothing. Silence,
//      never a fabricated zero.
function BudgetLine({ budget }) {
  if (!budget) return null
  const hasLimit = typeof budget.limit_tokens === 'number'
  const near = !!budget.near_limit
  return (
    <div
      role={near ? 'status' : undefined}
      className={`text-note mt-1.5 ${near ? 'font-medium' : 'text-dim'}`}
      style={near ? { color: 'var(--color-warn)' } : undefined}
    >
      {hasLimit
        ? `${budget.tokens_today.toLocaleString()} / ${budget.limit_tokens.toLocaleString()} tokens today`
        : `${budget.tokens_today.toLocaleString()} tokens today`}
      {' '}· counted by this server only — other uses of this key aren't visible to us
      {near ? ' — near the daily limit, the AI may stop answering soon' : ''}
    </div>
  )
}

function ChatCard({ panelId }) {
  const { COLORS } = useChartTheme()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [items, setItems] = useState([])
  const [budget, setBudget] = useState(null)
  const inRef = useRef(null)
  // The input is disabled while a question runs, which drops focus to the page.
  // Put it back when the answer lands.
  const wasBusy = useRef(false)
  useEffect(() => {
    // Only when the disabled input left focus on the page. Someone who has gone
    // on to another control while waiting keeps it.
    const a = document.activeElement
    if (wasBusy.current && !busy && (!a || a === document.body || a === inRef.current)) inRef.current?.focus()
    wasBusy.current = busy
  }, [busy])

  const submit = (qArg) => {
    const q = String(qArg != null ? qArg : input).trim()
    if (!q || busy) return
    setItems((list) => [...list, { role: 'user', text: q }])
    setInput('')
    setBusy(true)
    fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => null)
        return { r, j }
      })
      .then(({ r, j }) => {
        // Budget can ride along on a rate-limit error response too — that IS the
        // near_limit warning this feature exists for, so read it before branching
        // on outcome. Only ever set from a real "budget" object; never inferred.
        if (j && j.budget) setBudget(j.budget)
        if (r.status === 503 || (j && j.locked)) {
          setItems((list) => [...list, { role: 'assistant', error: 'Vault locked — unlock to query.' }])
          return
        }
        if (j && j.error) {
          setItems((list) => [...list, { role: 'assistant', error: String(j.error) }])
          return
        }
        if (!r.ok && !(j && typeof j.answer === 'string')) {
          setItems((list) => [...list, { role: 'assistant', error: `HTTP ${r.status}` }])
          return
        }
        setItems((list) => [
          ...list,
          {
            role: 'assistant',
            text: j && typeof j.answer === 'string' ? j.answer : 'Query returned an unexpected response.',
            suggestions: j && Array.isArray(j.suggestions) ? j.suggestions : [],
            trace: j && Array.isArray(j.trace) ? j.trace : null,
          },
        ])
      })
      .catch(() => {
        setItems((list) => [...list, { role: 'assistant', error: 'Query failed — server unreachable' }])
      })
      .finally(() => setBusy(false))
  }

  const ask = (sg) => submit(sg)

  return (
    <Card panelId={panelId} title="Ask AI" span={4}>
      <div role="log" aria-live="polite" className="flex flex-col gap-2 min-h-[280px] max-h-[480px] overflow-y-auto mb-3">
        {items.length === 0 ? (
          <Empty>Ask a question or pick a suggestion below</Empty>
        ) : (
          items.map((it, i) => <Message key={i} item={it} />)
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {SUGGESTIONS.map((sg, i) => (
          <button
            key={i}
            className="text-note px-2 py-1 rounded-control border border-border text-muted hover:text-field-txt hover:border-border-hover"
            onClick={() => ask(sg)}
          >
            {sg}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          ref={inRef}
          className={`${inputCls} flex-1 text-copy`}
          aria-label="Ask about your network"
          placeholder="Ask about your network…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          disabled={busy}
        />
        <button
          className="px-3 py-1.5 rounded-control text-copy font-medium text-on-accent disabled:opacity-40"
          style={{ background: COLORS.accent }}
          onClick={() => submit()}
          disabled={busy || !input.trim()}
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>
      <BudgetLine budget={budget} />
    </Card>
  )
}

// ---------- threat lookup ----------

function EntitiesTable({ entities, availability, reason, onRetry }) {
  // ThreatLookup degrades to entities:[] on a dead upstream search — indistinguishable
  // from a genuine "no matches" unless availability is checked first.
  if (availability === 'error') {
    return <FeedUnavailable reason={reason} label="Threat lookup unavailable" onRetry={onRetry} />
  }
  if (entities == null) return null
  if (Array.isArray(entities)) {
    if (!entities.length) return <div className="text-copy text-muted">No matches</div>
    if (typeof entities[0] === 'object' && entities[0]) {
      const cols = Object.keys(entities[0])
      return (
        // Scrolls sideways rather than clipping: beside the chat the panel is
        // narrow, and a column cut off at the edge could not be reached at all.
        // Focusable so the keyboard can scroll it too.
        <div tabIndex={0} aria-label="Lookup matches" className="overflow-x-auto overflow-y-auto max-h-[280px]">
          <table className="w-full text-note font-mono">
            <thead>
              <tr className="text-muted text-left">
                {cols.map((c) => (
                  <th key={c} className="pr-3 pb-1 font-medium">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entities.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {cols.map((c) => {
                    const v = typeof row[c] === 'object' && row[c] != null ? JSON.stringify(row[c]) : String(row[c] ?? '—')
                    return (
                      <td key={c} className="pr-3 py-1 text-field-txt align-top">
                        <span className="block overflow-hidden whitespace-nowrap" style={{ maxWidth: 180 }} title={v}>
                          {v}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
  }
  return (
    <pre className="font-mono text-note text-muted whitespace-pre-wrap p-2 rounded-control border border-border bg-field max-h-[300px] overflow-auto">
      {JSON.stringify(entities, null, 2)}
    </pre>
  )
}

function BlockDomainButton({ domain, disabled }) {
  const { COLORS } = useChartTheme()
  const [state, setState] = useState('idle') // idle | busy | blocked | tokenRequired | error
  const [msg, setMsg] = useState('')
  const [unconfirmed, setUnconfirmed] = useState(false)
  const lastActionRef = useRef('block')
  const aliveRef = useRef(true)
  useEffect(() => {
    return () => { aliveRef.current = false }
  }, [])

  const looksLikeDomain = !!domain && domain.includes('.') && !domain.includes(' ')
  if (!looksLikeDomain) return null
  // Showing a kept result from an earlier lookup: no write to the tenant, not
  // even Unblock, on evidence this lookup did not return.
  if (disabled) {
    return (
      <div className="flex items-center gap-1.5 mt-2">
        <button disabled className="px-2 py-1 rounded-control text-note border border-border text-muted opacity-50">Block domain</button>
        <span className="text-note text-muted">off while an earlier result is shown</span>
      </div>
    )
  }

  async function run(action) {
    lastActionRef.current = action
    setState('busy')
    const res = await authFetch(`/api/${action}-domain`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    })
    if (!aliveRef.current) return
    if (res.ok) {
      setState(action === 'block' ? 'blocked' : 'idle')
    } else if (res.tokenRequired) {
      setState('tokenRequired')
    } else {
      setState('error')
      setUnconfirmed(res.data?.outcome === 'unverified')
      setMsg((res.data && res.data.error) || `HTTP ${res.status}`)
    }
  }

  if (state === 'busy') return <span className="text-note text-muted">…</span>
  if (state === 'blocked') {
    return (
      <div className="flex items-center gap-1.5 mt-2">
        <span className="text-note" style={{ color: COLORS.ok }}>blocked ✓</span>
        <button onClick={() => run('unblock')} className="px-2 py-1 rounded-control text-note border border-border text-muted">Unblock</button>
      </div>
    )
  }
  if (state === 'tokenRequired') return <div className="mt-2 text-note" style={{ color: COLORS.warn }}>token required — set in ⋯ Settings</div>
  if (state === 'error') {
    // Only a click runs it again, never a timer: an unconfirmed change may
    // already have applied, so that one asks to be re-checked, not retried.
    return (
      <div className="mt-2 flex items-center gap-1.5">
        <span className="text-note" style={{ color: COLORS.crit }}>{msg}</span>
        <button onClick={() => run(lastActionRef.current)} className="px-2 py-1 rounded-control text-note border border-border text-muted">
          {unconfirmed ? 'Re-check' : 'Retry'}
        </button>
      </div>
    )
  }
  return (
    <button onClick={() => run('block')} className="mt-2 px-2 py-1 rounded-control text-note border border-border text-muted hover:text-field-txt">Block domain</button>
  )
}

// "from your earlier lookup of X, at HH:MM": a result kept from the last good
// lookup of the same search, shown under that part's failure.
function KeptResult({ kept, children }) {
  const t = new Date(kept.at)
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  return (
    <div data-kept-result="" className="mt-2 pl-3 border-l-2 border-border">
      <div className="text-note text-muted mb-1">from your earlier lookup of {kept.q}, at {hhmm}</div>
      {children}
    </div>
  )
}

function LookupCard({ panelId }) {
  const { COLORS } = useChartTheme()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const [dossier, setDossier] = useState(null)
  const [err, setErr] = useState(null)
  const [queryUsed, setQueryUsed] = useState('')
  // The last good answer of each part, with the search that produced it. Shown
  // only when a retry of that SAME search fails; a different search shows only
  // its own result or error.
  const [kept, setKept] = useState({ entities: null, dossier: null })
  // Answers count only for the lookup they were requested in, so a late answer
  // to an earlier search can neither show under a newer one nor replace what
  // is kept for it.
  const genRef = useRef(0)

  const lookup = async () => {
    const query = q.trim()
    // Enter reaches here as well as the button, and the button's disabled
    // state does not stop Enter, so a running lookup is checked for here.
    if (!query || busy) return
    const gen = ++genRef.current
    const current = () => gen === genRef.current
    setBusy(true); setErr(null); setRes(null); setDossier(null); setQueryUsed(query)
    fetch(`/api/dossier?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!current()) return
        // A non-200 (vault-gate 503 {error,locked}, a recover500 panic body) must
        // never pass its error body through as if it were dossier data — that is
        // how a lookup that never ran got painted CLEAN.
        if (!r.ok) {
          const reason = (body && (body.error || body.reason)) || `HTTP ${r.status}`
          setDossier({ unavailable: reason })
          return
        }
        // A 200 that is not readable JSON is a failure, not an absent dossier.
        setDossier(body || { unavailable: 'unreadable response' })
        if (dossierHasVerdict(body)) setKept((k) => ({ ...k, dossier: { q: query, at: Date.now(), data: body } }))
      })
      // A dossier that never answered is a failure too, not silence.
      .catch((e) => { if (current()) setDossier({ unavailable: String(e?.message || e) }) })
    try {
      const r = await fetch(`/api/threat-lookup?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
      const body = await r.json().catch(() => null)
      if (!current()) return
      // A 200 that is not readable JSON is a failure too, not "No matches".
      if (!r.ok || !body || body.error) setErr((body && body.error) || (r.ok ? 'unreadable response' : `HTTP ${r.status}`))
      else {
        setRes(body)
        if (body.availability !== 'error') setKept((k) => ({ ...k, entities: { q: query, at: Date.now(), data: body } }))
      }
    } catch (e) {
      if (!current()) return
      setErr(String(e?.message || e))
    }
    setBusy(false)
  }

  const entitiesFailed = !!err || res?.availability === 'error'
  const keptEntities = entitiesFailed && kept.entities?.q === queryUsed ? kept.entities : null
  const keptDossier = dossier && !dossierHasVerdict(dossier) && kept.dossier?.q === queryUsed ? kept.dossier : null

  return (
    <Card panelId={panelId} title="Threat lookup" span={2}>
      <div className="flex gap-2 mb-3">
        <input
          className={`${inputCls} flex-1 text-copy`}
          aria-label="Look up a domain, IP, or host"
          placeholder="domain, IP, or host…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') lookup() }}
        />
        <button
          className="px-3 py-1.5 rounded-control text-copy font-medium text-on-accent disabled:opacity-40"
          style={{ background: COLORS.accent }}
          onClick={lookup}
          disabled={busy || !q.trim()}
        >
          {busy ? 'Looking up…' : 'Lookup'}
        </button>
      </div>
      {err && <div className="text-copy mb-2" style={{ color: COLORS.sevHigh }}>{err}</div>}
      {!err && !res && !dossier && !busy && <Empty>Look up a domain, IP, or host</Empty>}
      {res && <EntitiesTable entities={res.entities} availability={res.availability} reason={res.reason} onRetry={lookup} />}
      {keptEntities && (
        <KeptResult kept={keptEntities}>
          <EntitiesTable entities={keptEntities.data.entities} availability={keptEntities.data.availability} />
        </KeptResult>
      )}
      {(res || dossier || keptEntities) && <BlockDomainButton domain={queryUsed} disabled={!!(keptEntities || keptDossier)} />}
      {/* Threat intel is one of five sources the dossier page shows for the
          same indicator (assets, DNS, IPAM and recent changes are the other
          four). Nothing here is removed or moved — this is a way OUT of a
          card that only ever answers one of those five questions. */}
      {queryUsed && (
        <a
          href={`#dossier?q=${encodeURIComponent(queryUsed)}`}
          className="inline-block mt-2 text-note no-underline text-muted hover:text-field-txt"
        >
          open full dossier →
        </a>
      )}
      <DossierPanel data={dossier} />
      {keptDossier && (
        <KeptResult kept={keptDossier}>
          <DossierPanel data={keptDossier.data} />
        </KeptResult>
      )}
    </Card>
  )
}

// EgressNotice states, before the box is used, that asking a question sends live
// tenant data off this machine and to where.
//
// NOTHING SAID SO. Not this tab, not the README, not DEPLOYMENT.md. Measured
// against a capture server standing in for the provider, one question ("which
// hosts are offline?") sent 5,879 bytes including real hostnames and internal IP
// addresses; across the eleven tools the same path sends subnet names and
// addresses, DNS zone FQDNs, DNS view comments, DHCP lease hostnames, threat feed
// names, and audit log entries with the user identity and role attached.
//
// That egress is not a bug — the feature cannot work without it. Not telling the
// operator was. The destination is read from the configured LLM base URL rather
// than hardcoded, so a self-hosted or proxied endpoint reports itself honestly
// instead of being described as Groq.
function EgressNotice() {
  const [host, setHost] = useState(null)
  const [unknown, setUnknown] = useState(false)

  useEffect(() => {
    fetch('/api/vault/status', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((d) => {
        const base = (d && d.llm && d.llm.base_url) || ''
        if (!base) { setHost('api.groq.com'); return }
        try { setHost(new URL(base).host || base) } catch { setHost(base) }
      })
      // A failed read must not render as "nothing leaves" — say we don't know.
      .catch(() => setUnknown(true))
  }, [])

  return (
    <div
      className="text-note rounded-control border px-3 py-2 mb-3"
      style={{ borderColor: 'var(--color-warn)', color: 'var(--color-warn)' }}
    >
      {unknown
        ? 'Asking a question sends live data from this tenant to your configured AI provider. The provider address could not be read just now.'
        : host === null
          ? 'Checking where questions are sent…'
          : `Asking a question sends live data from this tenant — hostnames, IP addresses, DNS names, audit entries — to ${host}. Nothing is sent until you ask.`}
    </div>
  )
}

// ---------- main ----------

// Layout "B · Desk": asking leads, wide and filled; Threat lookup sits beside
// it, narrower and open (index.css, [data-panel-id="ai-threat-lookup"]), so
// both are usable at once and the lookup never reads as the model's evidence.
export default function Ai() {
  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-copy font-semibold tracking-tight mb-1">AI Assistant</h1>
      <TabIntro anchor="ai">
        Ask questions about your own network in plain language — answers show the tools used, so you can check
        where a number came from. Threat lookup takes a domain, IP, or host and returns intel plus a dossier.
        Chat needs an LLM key; Block domain needs a dashboard token.
      </TabIntro>
      <EgressNotice />
      {/* panelId sits on the wrapper component, not only on the Card inside it:
          CardGrid reads it off its own direct children to work out the saved
          order, and a literal buried on the inner <Card> is invisible to that. */}
      <CardGrid layoutKey="ai">
        <ChatCard panelId="ai-ask" />
        <LookupCard panelId="ai-threat-lookup" />
      </CardGrid>
    </div>
  )
}
