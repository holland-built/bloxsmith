import { useEffect, useRef, useState } from 'react'
import { useChartTheme, Card, Empty } from '../components/ui.jsx'
import { authFetch } from '../lib/authFetch.js'

const inputCls = 'px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt'

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
        <div className="max-w-[80%] px-3 py-2 rounded-lg bg-line-2 text-txt text-[13px]">{item.text}</div>
      </div>
    )
  }
  if (item.error) {
    return (
      <div className="flex justify-start">
        <div
          className="max-w-[85%] px-3 py-2 rounded-lg border text-[13px]"
          style={{ borderColor: 'var(--color-crit)', background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)' }}
        >
          {item.error}
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-3 py-2 rounded-lg border border-border bg-field text-field-txt text-[13px] whitespace-pre-wrap">
        {item.text}
        {!!(item.suggestions && item.suggestions.length) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {item.suggestions.map((sg, i) => (
              <span key={i} className="text-[11px] px-2 py-0.5 rounded-full border border-border text-muted">{sg}</span>
            ))}
          </div>
        )}
        {!!(item.trace && item.trace.length) && (
          <div className="mt-2 pt-2 border-t border-border font-mono text-[11px] text-muted space-y-0.5">
            {item.trace.map((t, i) => (
              <div key={i}>
                <span>{t.tool}</span> <span className="opacity-70">{JSON.stringify(t.args)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ChatCard() {
  const { COLORS } = useChartTheme()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [items, setItems] = useState([])
  const inRef = useRef(null)

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
    <Card title="Ask AI" span={1}>
      <div className="flex flex-col gap-2 min-h-[280px] max-h-[480px] overflow-y-auto mb-3">
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
            className="text-[11px] px-2 py-1 rounded-full border border-border text-muted hover:text-field-txt hover:border-border-hover"
            onClick={() => ask(sg)}
          >
            {sg}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          ref={inRef}
          className={`${inputCls} flex-1 text-[13px]`}
          placeholder="Ask about your network…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          disabled={busy}
        />
        <button
          className="px-3 py-1.5 rounded-lg text-[13px] font-medium text-white disabled:opacity-40"
          style={{ background: COLORS.accent }}
          onClick={() => submit()}
          disabled={busy || !input.trim()}
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>
    </Card>
  )
}

// ---------- threat lookup ----------

function EntitiesTable({ entities }) {
  if (entities == null) return null
  if (Array.isArray(entities)) {
    if (!entities.length) return <div className="text-sm text-muted">No matches</div>
    if (typeof entities[0] === 'object' && entities[0]) {
      const cols = Object.keys(entities[0])
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] font-mono">
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
                  {cols.map((c) => (
                    <td key={c} className="pr-3 py-1 text-field-txt align-top">
                      {typeof row[c] === 'object' && row[c] != null ? JSON.stringify(row[c]) : String(row[c] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
  }
  return (
    <pre className="font-mono text-[11px] text-muted whitespace-pre-wrap p-2 rounded-lg border border-border bg-field max-h-[300px] overflow-auto">
      {JSON.stringify(entities, null, 2)}
    </pre>
  )
}

function BlockDomainButton({ domain }) {
  const { COLORS } = useChartTheme()
  const [state, setState] = useState('idle') // idle | busy | blocked | tokenRequired | error
  const [msg, setMsg] = useState('')
  const aliveRef = useRef(true)
  useEffect(() => {
    return () => { aliveRef.current = false }
  }, [])

  const looksLikeDomain = !!domain && domain.includes('.') && !domain.includes(' ')
  if (!looksLikeDomain) return null

  async function run(action) {
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
      setMsg((res.data && res.data.error) || `HTTP ${res.status}`)
    }
  }

  if (state === 'busy') return <span className="text-[11px] text-muted">…</span>
  if (state === 'blocked') {
    return (
      <div className="flex items-center gap-1.5 mt-2">
        <span className="text-[11px]" style={{ color: COLORS.ok }}>blocked ✓</span>
        <button onClick={() => run('unblock')} className="px-2 py-1 rounded-lg text-[11px] border border-border text-muted">Unblock</button>
      </div>
    )
  }
  if (state === 'tokenRequired') return <div className="mt-2 text-[11px]" style={{ color: COLORS.warn }}>token required — set in ⚙ Settings</div>
  if (state === 'error') return <div className="mt-2 text-[11px]" style={{ color: COLORS.crit }}>{msg}</div>
  return (
    <button onClick={() => run('block')} className="mt-2 px-2 py-1 rounded-lg text-[11px] border border-border text-muted hover:text-field-txt">Block domain</button>
  )
}

function DossierPanel({ dossier }) {
  const { COLORS } = useChartTheme()
  if (!dossier) return null
  if (dossier.unavailable) {
    return <div className="text-[11px] text-muted mt-3">External intel unavailable: {String(dossier.unavailable)}</div>
  }
  const sum = dossier.summary || {}
  const sources = Array.isArray(dossier.sources) ? dossier.sources : []
  const mal = !!sum.malicious
  const meta = [
    ['Max threat level', sum.max_threat_level],
    ['Country', sum.country],
    ['Registrar', sum.registrar],
    ['Actor', sum.actor],
  ].filter((x) => x[1] != null && x[1] !== '')
  const classes = Array.isArray(sum.threat_classes) ? sum.threat_classes : []

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <h3 className="text-[12px] font-semibold text-muted mb-2">External intel (Dossier)</h3>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span
          className="font-mono text-[11px] px-2 py-0.5 rounded-lg border"
          style={{ color: mal ? COLORS.sevHigh : COLORS.ok, borderColor: mal ? COLORS.crit : 'var(--color-border)' }}
        >
          {mal ? 'malicious' : 'clean'}
        </span>
        {sum.max_threat_level != null && <span className="font-mono text-[11px] text-muted">threat {String(sum.max_threat_level)}</span>}
        {dossier.type && <span className="font-mono text-[11px] text-dim">{String(dossier.type)}</span>}
      </div>
      {!!classes.length && (
        <div className="flex gap-1 flex-wrap mb-2">
          {classes.map((c, i) => (
            <span key={i} className="text-[11px] px-2 py-0.5 rounded-full border border-border text-muted">{String(c)}</span>
          ))}
        </div>
      )}
      {!!meta.length && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] mb-2">
          {meta.map(([k, v]) => (
            <span key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="font-mono text-field-txt break-all">{String(v)}</dd>
            </span>
          ))}
        </dl>
      )}
      {sources.length > 0 ? (
        <EntitiesTable entities={sources} />
      ) : (
        <div className="font-mono text-[11px] text-muted">No sources reported.</div>
      )}
    </div>
  )
}

function LookupCard() {
  const { COLORS } = useChartTheme()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const [dossier, setDossier] = useState(null)
  const [err, setErr] = useState(null)
  const [queryUsed, setQueryUsed] = useState('')

  const lookup = async () => {
    const query = q.trim()
    if (!query) return
    setBusy(true); setErr(null); setRes(null); setDossier(null); setQueryUsed(query)
    fetch(`/api/dossier?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
      .then((r) => r.json().catch(() => null))
      .then((j) => { if (j) setDossier(j) })
      .catch(() => {})
    try {
      const r = await fetch(`/api/threat-lookup?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
      const body = await r.json().catch(() => null)
      if (!r.ok || (body && body.error)) setErr((body && body.error) || `HTTP ${r.status}`)
      else setRes(body || { entities: [], query })
    } catch (e) {
      setErr(String(e?.message || e))
    }
    setBusy(false)
  }

  return (
    <Card title="Threat lookup" span={1}>
      <div className="flex gap-2 mb-3">
        <input
          className={`${inputCls} flex-1 text-[13px]`}
          placeholder="domain, IP, or host…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') lookup() }}
        />
        <button
          className="px-3 py-1.5 rounded-lg text-[13px] font-medium text-white disabled:opacity-40"
          style={{ background: COLORS.accent }}
          onClick={lookup}
          disabled={busy || !q.trim()}
        >
          {busy ? 'Looking up…' : 'Lookup'}
        </button>
      </div>
      {err && <div className="text-[13px] mb-2" style={{ color: COLORS.sevHigh }}>{err}</div>}
      {!err && !res && !dossier && !busy && <Empty>Look up a domain, IP, or host</Empty>}
      {res && <EntitiesTable entities={res.entities} />}
      {(res || dossier) && <BlockDomainButton domain={queryUsed} />}
      <DossierPanel dossier={dossier} />
    </Card>
  )
}

// ---------- main ----------

export default function Ai() {
  return (
    <div className="max-w-[860px] mx-auto p-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">AI Assistant</h1>
      <div className="grid grid-cols-1 gap-4">
        <ChatCard />
        <LookupCard />
      </div>
    </div>
  )
}
