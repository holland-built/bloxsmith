import { useMemo, useState } from 'react'
import { abortAfter } from '../lib/api.js'
import { FIELD_CLS } from './ui.jsx'

// "Compare views" on the DNS tab: one zone name that lives in two or more DNS
// views, read record by record from two of them, and what differs. Read-only.
// The server (go/internal/server/dns_compare.go) reads every page of both
// zones and says when a read stopped early; this shows that sentence as is.
//
// Loaded on demand from Dns.jsx, so the DNS tab costs nothing extra until the
// button is pressed.

// The most rows each list draws; the rest are counted, not dropped silently.
const LIST_CAP = 200
// Two zones of up to 50,000 records each can take a while to read.
const COMPARE_TIMEOUT_MS = 120000

const TH = 'text-left font-medium text-muted px-2 py-1 border-b border-line'
const TD = 'px-2 py-1 border-b border-line align-top'

export default function ZoneCompare({ zones, onClose }) {
  // Zone names found in two or more views, A to Z, each with its views.
  const shared = useMemo(() => {
    const byName = new Map()
    for (const z of zones) {
      if (!z.fqdn || !z.id) continue
      if (!byName.has(z.fqdn)) byName.set(z.fqdn, [])
      byName.get(z.fqdn).push(z)
    }
    return [...byName.entries()].filter(([, zs]) => zs.length > 1).sort(([a], [b]) => a.localeCompare(b))
  }, [zones])

  const [name, setName] = useState(shared[0]?.[0] ?? '')
  const inName = shared.find(([n]) => n === name)?.[1] ?? []
  const [a, setA] = useState(inName[0]?.id ?? '')
  const [b, setB] = useState(inName[1]?.id ?? '')
  const [state, setState] = useState({ busy: false, error: '', result: null, names: null })

  function pickName(n) {
    const zs = shared.find(([x]) => x === n)?.[1] ?? []
    setName(n)
    setA(zs[0]?.id ?? '')
    setB(zs[1]?.id ?? '')
    setState({ busy: false, error: '', result: null, names: null })
  }

  const viewOf = (id) => inName.find((z) => z.id === id)?.view || id

  async function compare() {
    const names = { a: viewOf(a), b: viewOf(b) }
    setState({ busy: true, error: '', result: null, names })
    const { signal, cancel } = abortAfter(COMPARE_TIMEOUT_MS)
    try {
      const res = await fetch(`/api/dns/zone-compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, { cache: 'no-store', signal })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.status === 'error') {
        setState({ busy: false, error: body.error || `The comparison failed (${res.status}).`, result: null, names })
      } else {
        setState({ busy: false, error: '', result: body, names })
      }
    } catch {
      setState({ busy: false, error: 'The comparison took too long or could not reach Bloxsmith.', result: null, names })
    } finally {
      cancel()
    }
  }

  const r = state.result
  const n = state.names
  return (
    <section aria-label="Compare a zone in two views" className="mb-3 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex flex-col gap-1 text-note text-muted">
          Zone
          <select className={FIELD_CLS} value={name} onChange={(e) => pickName(e.target.value)}>
            {shared.map(([fqdn, zs]) => <option key={fqdn} value={fqdn}>{fqdn} ({zs.length} views)</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-note text-muted">
          First view
          <select className={FIELD_CLS} value={a} onChange={(e) => setA(e.target.value)}>
            {inName.map((z) => <option key={z.id} value={z.id}>{z.view}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-note text-muted">
          Second view
          <select className={FIELD_CLS} value={b} onChange={(e) => setB(e.target.value)}>
            {inName.map((z) => <option key={z.id} value={z.id}>{z.view}</option>)}
          </select>
        </label>
        <button type="button" disabled={state.busy || !a || !b || a === b} onClick={compare}
          className="px-3 py-1.5 rounded-control bg-accent text-on-accent text-copy font-medium disabled:opacity-60">
          {state.busy ? 'Comparing…' : 'Compare'}
        </button>
        <button type="button" onClick={onClose} className="text-copy text-muted underline px-1 py-1.5">Close</button>
      </div>
      {a && a === b && <p className="mt-2 text-note text-muted">Pick two different views.</p>}
      <p className="mt-2 text-note text-muted">Reads every record in both views. Changes nothing.</p>

      {state.error && <p role="alert" className="mt-2 text-copy text-crit">{state.error}</p>}

      {r && (
        <div className="mt-3">
          <p className="text-copy">
            Same in both: {r.same.toLocaleString()}. Only in {n.a}: {r.only_a.length.toLocaleString()}.
            {' '}Only in {n.b}: {r.only_b.length.toLocaleString()}. Different: {r.different.length.toLocaleString()}.
          </p>
          <p className="text-note text-muted">
            Read {r.a.records.toLocaleString()} records from {n.a} and {r.b.records.toLocaleString()} from {n.b}.
          </p>
          {r.status === 'partial' && (
            <div role="status" className="mt-2 text-copy" style={{ color: 'var(--pill-warn-fg)' }}>
              <p>Not every record was read, so the lists below may be missing some.</p>
              {r.a.note && <p>{n.a}: {r.a.note}</p>}
              {r.b.note && <p>{n.b}: {r.b.note}</p>}
            </div>
          )}
          <RecordList title={`Only in ${n.a}`} rows={r.only_a} />
          <RecordList title={`Only in ${n.b}`} rows={r.only_b} />
          <DiffList rows={r.different} names={n} />
        </div>
      )}
    </section>
  )
}

const ttlText = (v) => (v == null || v === '' ? '—' : String(v))

function Shown({ total }) {
  return total > LIST_CAP ? <p className="text-note text-muted">Showing the first {LIST_CAP.toLocaleString()} of {total.toLocaleString()}.</p> : null
}

function RecordList({ title, rows }) {
  if (!rows.length) return null
  return (
    <div className="mt-3">
      <h3 className="text-copy font-medium">{title}</h3>
      <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
        <table aria-label={title} className="w-full border-collapse text-copy">
          <thead><tr><th className={TH}>Name</th><th className={TH}>Type</th><th className={TH}>Value</th><th className={TH}>TTL</th></tr></thead>
          <tbody>
            {rows.slice(0, LIST_CAP).map((x, i) => (
              <tr key={i}>
                <td className={`${TD} font-mono`}>{x.name}</td><td className={TD}>{x.type}</td>
                <td className={`${TD} font-mono break-all`}>{x.data}</td><td className={`${TD} tabular-nums`}>{ttlText(x.ttl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Shown total={rows.length} />
    </div>
  )
}

function DiffList({ rows, names }) {
  if (!rows.length) return null
  const side = (recs, what) => recs.map((x, i) => <div key={i}>{what === 'ttl' ? `${x.data} (TTL ${ttlText(x.ttl)})` : x.data}</div>)
  return (
    <div className="mt-3">
      <h3 className="text-copy font-medium">Different</h3>
      <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
        <table aria-label="Different" className="w-full border-collapse text-copy">
          <thead><tr><th className={TH}>Name</th><th className={TH}>Type</th><th className={TH}>What differs</th><th className={TH}>{names.a}</th><th className={TH}>{names.b}</th></tr></thead>
          <tbody>
            {rows.slice(0, LIST_CAP).map((x, i) => (
              <tr key={i}>
                <td className={`${TD} font-mono`}>{x.name}</td><td className={TD}>{x.type}</td>
                <td className={TD}>{x.what === 'ttl' ? 'Cache time (TTL)' : 'Value'}</td>
                <td className={`${TD} font-mono break-all`}>{side(x.a, x.what)}</td>
                <td className={`${TD} font-mono break-all`}>{side(x.b, x.what)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Shown total={rows.length} />
    </div>
  )
}
