import { questionFromHash } from '../lib/oneBox.js'
import { useEffect, useRef, useState } from 'react'
import { chatContext } from '../lib/aiContext.js'
import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, TabIntro } from '../components/ui.jsx'
import { authFetch } from '../lib/authFetch.js'
import DossierPanel from '../components/DossierPanel.jsx'
import { dossierHasVerdict } from '../lib/dossierVerdict.js'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { parseInline } from '../lib/markdown.js'
import { answerBlocks } from '../lib/aiAnswer.js'

const inputCls = 'px-2.5 py-1.5 rounded-control border border-field-border bg-field text-field-txt'

const SUGGESTIONS = [
  'Which subnets are nearly full?',
  'Which domains are on threat feeds?',
  'Any lookalike domains of my brand?',
  'Are any of my DNS zones misconfigured?',
  'Which hosts are offline?',
  'What changed in the last 24 hours?',
]

// ---------- chat ----------

function Message({ item, onRetry, onAsk }) {
  if (item.role === 'user') {
    return (
      <div data-role="user" className="flex justify-end">
        <div className="max-w-[85%] px-4 py-2.5 rounded-surface bg-line-2 text-txt text-copy whitespace-pre-wrap">{item.text}</div>
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
          {onRetry && item.question ? <RetryButton onClick={() => onRetry(item.question)} /> : null}
        </div>
      </div>
    )
  }
  // A calm centred column, the way the Claude chat reads: the answer is the one
  // loud thing, its proof sits right under it, and what to ask next comes after
  // a rule.
  const suggestions = (item.suggestions || []).slice(0, 3)
  return (
    <div className="max-w-[560px] mx-auto w-full text-field-txt text-copy leading-relaxed">
      <AnswerText text={item.text} />
      {!!(item.trace && item.trace.length) && <Lookups trace={item.trace} />}
      {item.ranOut && onRetry && item.question ? <RetryButton onClick={() => onRetry(item.question)} /> : null}
      {suggestions.length > 0 && (
        <div className="mt-9 pt-4 border-t border-line">
          <p className="text-note text-muted mb-1">Ask next</p>
          <ul aria-label="Ask next">
            {suggestions.map((sg, i) => (
              <li key={i} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  disabled={!onAsk}
                  onClick={() => onAsk(sg)}
                  className="w-full text-left py-2.5 px-0.5 text-txt hover:bg-line disabled:opacity-60"
                >
                  {sg}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// How the answer was found, folded away. The facts stay in view on one line:
// `fact` is counted by the server from the rows themselves, not written by the
// model. Text inside the tenant's own data can steer the prose above
// (demonstrated: a hostname carrying an injected instruction made the model
// report "all hosts are online" while holding data showing one offline). It
// cannot change these facts, so an answer that contradicts them is visibly
// contradicted.
function Lookups({ trace }) {
  const facts = trace.map((t) => t.fact).filter(Boolean)
  // "72535 subnets exist in total; the 25 below are a sample, not the full
  // list." keeps its count. Only that clause goes; any other part stays. One
  // fact can hold two sentences (get_dns sends views and zones together), so
  // every sample clause goes, and each sentence becomes its own item.
  const short = facts
    .flatMap((f) => f.replace(/;?\s*the \d+ below (are|is) a sample, not the full list\.?/gi, '|').split(/\||\.\s+/))
    .map((f) => f.trim().replace(/\.$/, '').replace(/(^|[\s(])(\d{4,})(?=\s+[A-Za-z])/g, (_, pre, n) => pre + Number(n).toLocaleString('en-US')))
    .filter(Boolean)
  return (
    <div className="mt-2.5 text-note text-muted text-center">
      {short.length > 0 && <span title={facts.join('\n')}>Counted by Bloxsmith: {short.join(' · ')}. </span>}
      <details className="inline">
        <summary className="inline cursor-pointer underline underline-offset-2">How I got this</summary>
        <div className="mt-2 font-mono space-y-1 text-left">
          {trace.map((t, i) => (
            <div key={i}>
              <div>{t.tool} <span className="opacity-70 break-all">{JSON.stringify(t.args)}</span></div>
              {t.fact ? <div className="opacity-90">↳ {t.fact}</div> : null}
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

// Bold, code and links in the answer. A link shows as its words only, never
// as a clickable link: the answer can carry text planted in the tenant's own
// data (see rule 9 in go/internal/ai/schema.go), so it must not be able to put
// a working link in front of the reader.
function AnswerInline({ text }) {
  return parseInline(text).map((tok, i) => {
    if (tok.type === 'strong') return <strong key={i} className="font-semibold">{tok.text}</strong>
    if (tok.type === 'em') return <em key={i}>{tok.text}</em>
    if (tok.type === 'code') return <code key={i} className="font-mono text-note">{tok.text}</code>
    return <span key={i}>{tok.text}</span>
  })
}

// The answer as markdown (lib/aiAnswer.js). React escapes every string here,
// so nothing in the answer can become markup.
// A table cell that is a number ("1,447", "1,607+", "82%"), and one that says
// a part could not be counted.
const NUMBER = /^[<>~≈]?\s*-?[\d,.]+\s*[%+]?$/
const MISSING = /^(couldn't check|could not check|not checked)$/i

function AnswerText({ text }) {
  return answerBlocks(text).map((b, i) => {
    // The answer's first line is the answer: large, bold, centred.
    if (i === 0 && b.type === 'para') {
      return <p key={i} className="mt-8 text-center text-figure font-bold leading-snug [&_strong]:font-bold"><AnswerInline text={b.text} /></p>
    }
    if (b.type === 'table') {
      // Centred under the answer. A column of numbers lines up on the right, a
      // Total row is bold, and a part that could not be checked is in amber,
      // so the table carries the caveat and nothing else has to repeat it.
      const plain = (c) => String(c).replace(/\*\*/g, '').trim()
      const numCol = b.head.map((_, m) => {
        const cells = b.body.map((r) => plain(r[m] ?? '')).filter((c) => c && !MISSING.test(c))
        return cells.length > 0 && cells.every((c) => NUMBER.test(c))
      })
      return (
        <div key={i} className="overflow-x-auto my-3 w-fit max-w-full mx-auto">
          <table className="border-collapse text-copy">
            <thead>
              <tr>
                {b.head.map((h, n) => (
                  <th key={n} className={`${numCol[n] ? 'text-right' : 'text-left'} text-note font-medium text-muted border-b border-border px-2 py-1`}><AnswerInline text={h} /></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.body.map((row, n) => (
                <tr key={n} className={/^total\b/i.test(plain(row[0] ?? '')) ? 'font-semibold' : undefined}>
                  {row.map((c, m) => (
                    <td
                      key={m}
                      className={`align-top border-b border-border px-2 py-1 ${numCol[m] ? 'text-right tabular-nums' : 'text-left'}`}
                      style={MISSING.test(plain(c)) ? { color: 'var(--color-warn)' } : undefined}
                    >
                      <AnswerInline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    if (b.type === 'ul' || b.type === 'ol') {
      const List = b.type === 'ul' ? 'ul' : 'ol'
      return (
        <List key={i} className={`${b.type === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 my-1`}>
          {b.items.map((it, n) => <li key={n}><AnswerInline text={it} /></li>)}
        </List>
      )
    }
    if (b.type === 'hr') return <hr key={i} className="border-0 border-t border-border my-1.5" />
    // Paragraphs, and headings or quotes the model was told not to write,
    // all show as a plain line.
    return <p key={i} className="my-0.5"><AnswerInline text={b.text} /></p>
  })
}

function RetryButton({ onClick }) {
  return (
    <div className="mt-2">
      <button type="button" className="text-note font-medium px-2 py-0.5 rounded-control border border-border hover:border-border-hover" onClick={onClick}>
        Try again
      </button>
    </div>
  )
}

// While a question runs there is nothing to stream, so say what is happening
// and how long it has taken: 35 silent seconds read as a hang.
function Working() {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setSecs((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="flex justify-start">
      <div className="py-1 text-note text-muted">
        Looking this up in your Infoblox account… <span className="tabular-nums">{secs} s</span>
        {secs >= 20 ? <div>Questions that need several lookups can take up to a minute.</div> : null}
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

const CHAT_KEY = 'bx:ai-chat'

function ChatCard({ panelId }) {
  const { COLORS } = useChartTheme()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // Kept for this browser tab, so going to another page and back keeps the chat.
  const [items, setItems] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(CHAT_KEY) || '[]') } catch { return [] }
  })
  useEffect(() => {
    try { sessionStorage.setItem(CHAT_KEY, JSON.stringify(items.slice(-40))) } catch { /* storage full or off */ }
  }, [items])
  const [budget, setBudget] = useState(null)
  const [egress, setEgress] = useState({ loaded: false, host: '', key: null })
  // Understood also holds for this visit when the browser will not store it.
  const [acceptedHere, setAcceptedHere] = useState(null)
  useEffect(() => { readEgress().then(setEgress) }, [])
  // An unknown host can never be accepted: nothing is sent until the user knows where it goes.
  const accepted = (e) => !!e.key && (egressAccepted(e.key) || acceptedHere === e.key)
  const checking = useRef(false)
  const inRef = useRef(null)
  const logRef = useRef(null)
  // Put the latest question at the top of the box, so its answer reads from
  // the start. Scrolling to the very end hid the bold answer above the fold.
  useEffect(() => {
    const el = logRef.current
    const q = el?.querySelectorAll('[data-role="user"]')
    const last = q?.[q.length - 1]
    if (!last) return
    el.scrollTop += last.getBoundingClientRect().top - el.getBoundingClientRect().top
  }, [items, busy])
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

  // Every question passes here: typed, a suggestion, or #ai?q= from the header
  // box. Until the notice is understood for the provider host, it waits in the
  // box instead of being sent.
  const submit = (qArg) => {
    const q = String(qArg != null ? qArg : input).trim()
    if (!q) return
    // One question at a time. One that arrives mid-answer waits in the box.
    if (busy || checking.current) { if (qArg != null) setInput(q); return }
    checking.current = true
    readEgress().then((e) => {
      checking.current = false
      setEgress(e)
      if (!accepted(e)) { setInput(q); return }
      send(q)
    })
  }

  const send = (q) => {
    setItems((list) => [...list, { role: 'user', text: q }])
    setInput('')
    if (inRef.current) inRef.current.style.height = 'auto'
    // The first question swaps the empty view for the chat, which remounts
    // the box; put the cursor back in it.
    requestAnimationFrame(() => inRef.current?.focus())
    setBusy(true)
    fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, context: chatContext(items) }),
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
          setItems((list) => [...list, { role: 'assistant', error: String(j.error), question: q }])
          return
        }
        if (!r.ok && !(j && typeof j.answer === 'string')) {
          setItems((list) => [...list, { role: 'assistant', error: `HTTP ${r.status}`, question: q }])
          return
        }
        setItems((list) => [
          ...list,
          {
            role: 'assistant',
            text: j && typeof j.answer === 'string' ? j.answer : 'Query returned an unexpected response.',
            suggestions: j && Array.isArray(j.suggestions) ? j.suggestions : [],
            trace: j && Array.isArray(j.trace) ? j.trace : null,
            question: q,
            // The server's words when its lookups ran and no answer came of
            // them (go/internal/ai/ai.go ranOutJSON): offer the same question again.
            ranOut: j && typeof j.answer === 'string' && j.answer.includes("couldn't put an answer together"),
          },
        ])
      })
      .catch(() => {
        setItems((list) => [...list, { role: 'assistant', error: 'Query failed — server unreachable', question: q }])
      })
      .finally(() => setBusy(false))
  }

  const ask = (sg) => submit(sg)

  // A question from the header box or an "Ask why" link arrives as #ai?q=…
  // and is asked straight away. The q is then taken off the address, so a
  // reload or Back doesn't ask (and spend tokens) a second time.
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const take = () => {
      const q = questionFromHash(location.hash)
      if (!q) return
      history.replaceState(null, '', location.pathname + location.search + '#ai')
      submitRef.current(q)
    }
    take()
    window.addEventListener('hashchange', take)
    return () => window.removeEventListener('hashchange', take)
  }, [])

  const composer = (
    <div className="mx-auto w-full max-w-[760px]">
      <div className="flex items-end gap-2 rounded-surface border border-field-border bg-field px-3 py-2 focus-within:border-border-hover">
        <textarea
          ref={inRef}
          rows={1}
          className="flex-1 resize-none bg-transparent text-field-txt text-copy py-1.5 outline-none max-h-40"
          aria-label="Ask about your network"
          placeholder="Ask about your network…"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            // Grow with the text, up to the max height, like a chat box.
            e.target.style.height = 'auto'
            e.target.style.height = `${e.target.scrollHeight}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          className="shrink-0 px-3 py-1.5 rounded-control text-copy font-medium text-on-accent disabled:opacity-40"
          style={{ background: COLORS.accent }}
          onClick={() => submit()}
          disabled={busy || !input.trim() || !accepted(egress)}
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>
      <p className="text-note text-muted mt-1 text-center">Enter to send, Shift+Enter for a new line.</p>
      <EgressNotice
        egress={egress}
        accepted={accepted(egress)}
        onAccept={() => {
          acceptEgress(egress.key)
          setAcceptedHere(egress.key)
          inRef.current?.focus()
        }}
      />
    </div>
  )

  return (
    <Card panelId={panelId} title="Ask AI" span={4}>
      {items.length === 0 ? (
        // A new chat: the question, the box, then ideas, as ChatGPT and Claude open.
        <div className="flex flex-col items-center text-center px-2 py-3 sm:py-14">
          <p className="text-figure font-semibold text-txt mb-2">What do you want to know about your network?</p>
          <p className="text-copy text-muted mb-5">Ask in plain words. Each answer shows the lookups behind it.</p>
          <div className="w-full text-left">{composer}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-[760px] mt-5">
            {SUGGESTIONS.map((sg, i) => (
              <button
                key={i}
                type="button"
                className={`text-left text-copy px-3 py-2.5 rounded-surface border border-border text-field-txt hover:bg-line-2 ${i >= 4 ? 'hidden sm:block' : ''}`}
                onClick={() => ask(sg)}
              >
                {sg}
              </button>
            ))}
          </div>
        </div>
      ) : (
        // Fills the window below the page title, so a long answer shows more of itself.
        <div className="flex flex-col h-[calc(100dvh-304px)] min-h-[420px]">
          <div className="flex justify-end -mt-1 mb-1">
            <button
              type="button"
              className="text-note text-muted hover:text-field-txt underline-offset-2 hover:underline disabled:opacity-40"
              onClick={() => { setItems([]); setInput('') }}
              disabled={busy}
            >
              New chat
            </button>
          </div>
          <div role="log" aria-live="polite" aria-label="Conversation" tabIndex={0} ref={logRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[760px] flex flex-col gap-5 py-2">
              {items.map((it, i) => <Message key={i} item={it} onRetry={busy ? null : submit} onAsk={busy ? null : submit} />)}
              {busy ? <Working /> : null}
            </div>
          </div>
          <div className="pt-3">{composer}</div>
        </div>
      )}
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
    <div data-kept-result="" className="mt-2 pl-3 border-l border-border">
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
        <input {...MACHINE_TEXT}
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

// The egress notice states, before the first question, that asking sends live
// tenant data off this machine and to where. Asking stays off until the reader
// has pressed Understood, once per provider host: a new host asks again.
//
// NOTHING SAID SO. Not this tab, not the README, not DEPLOYMENT.md. Measured
// against a capture server standing in for the provider, one question ("which
// hosts are offline?") sent 5,879 bytes including real hostnames and internal IP
// addresses; across the eleven tools the same path sends subnet names and
// addresses, DNS zone FQDNs, DNS view comments, DHCP lease hostnames, threat feed
// names, and audit log entries with the user identity and role attached.
//
// That egress is not a bug — the feature cannot work without it. Not telling the
// operator was. The destination is the server's llmSendsTo (the vault's base URL, else
// LLM_BASE_URL, else api.groq.com) rather than hardcoded, so a self-hosted or proxied endpoint reports itself honestly
// instead of being described as Groq.
const EGRESS_KEY = 'bx:ai-egress-ok'

// Read fresh before every question: the provider can change in Settings while
// this page stays open. key is null when the host is unknown.
async function readEgress() {
  try {
    const r = await fetch('/api/vault/status', { cache: 'no-store' })
    if (!r.ok) throw new Error(String(r.status))
    const d = await r.json()
    const host = (d && d.llmSendsTo) || ''
    return { loaded: true, host, key: host || null }
  } catch {
    return { loaded: true, host: '', key: null }
  }
}

function egressAccepted(key) {
  if (!key) return false
  try { return JSON.parse(localStorage.getItem(EGRESS_KEY) || '[]').includes(key) } catch { return false }
}

function acceptEgress(key) {
  if (!key) return
  try {
    const list = JSON.parse(localStorage.getItem(EGRESS_KEY) || '[]')
    if (!list.includes(key)) localStorage.setItem(EGRESS_KEY, JSON.stringify([...list, key].slice(-20)))
  } catch { /* storage off: asked again next visit */ }
}

function EgressNotice({ egress, accepted, onAccept }) {
  const [open, setOpen] = useState(false)
  const { host, loaded } = egress
  if (accepted && !open) {
    return (
      <p className="text-note text-muted mt-1 text-center">
        Questions send tenant data to {host || 'your AI provider'}.{' '}
        <button type="button" className="underline underline-offset-2" onClick={() => setOpen(true)}>Details</button>
      </p>
    )
  }
  const text = !loaded
    ? 'Checking where questions are sent…'
    : host
      ? `Asking a question sends live data from this tenant, such as hostnames, IP addresses, DNS names and audit entries, to ${host}. Nothing is sent until you ask.`
      : 'Asking a question sends live data from this tenant to your configured AI provider. Its address could not be read, so asking is off until it can be. Reload the page to try again.'
  return (
    <div role="note" className="mt-3 text-note text-left rounded-control border px-3 py-2.5" style={{ borderColor: 'var(--color-warn)', color: 'var(--color-warn)' }}>
      {text}
      <div className="mt-2 flex justify-end">
        {accepted ? (
          <button type="button" className="underline underline-offset-2" onClick={() => setOpen(false)}>Hide</button>
        ) : (
          <button
            type="button"
            disabled={!host}
            onClick={onAccept}
            className="px-3 py-1 rounded-control font-semibold disabled:opacity-40"
            style={{ background: 'var(--color-warn)', color: 'var(--color-bg)' }}
          >
            Understood
          </button>
        )}
      </div>
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
      <TabIntro>Ask about your network in plain words, or look up a domain, IP or host.</TabIntro>
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
