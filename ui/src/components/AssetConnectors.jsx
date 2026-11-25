import { useState } from 'react'
import { SLOW_COLD_TIMEOUT_MS, useApi } from '../lib/api.js'
import { parseSeen, seenAgo } from '../lib/assetTypes.js'
import { Card, FeedUnavailable, Skeleton } from './ui.jsx'

// Connection health on the Assets tab: each discovery connection (AWS, Azure,
// Active Directory...) and whether its last sync worked. The server orders
// them failing first (go/internal/dashboard/connectors.go). Read-only: there
// is no button here that changes a connection.
//
// Working and turned-off connections wait behind one button, so the list
// opens on the ones that need a look.

// The app's status colours (index.css tokens), on a dot beside the word.
const DOT = {
  failing: 'var(--color-crit)',
  partial: 'var(--color-warn)',
  ok: 'var(--color-ok)',
}
const ORDER = [['failing', 'failing'], ['partial', 'partly working'], ['unknown', 'unknown'], ['syncing', 'syncing'], ['ok', 'working'], ['off', 'turned off']]
const QUIET = new Set(['ok', 'off'])
// A message longer than this, or on more than one line, is cut short.
const SHORT = 90

// A partly working connection: Infoblox's own text often opens with what
// worked ("Asset Discovery and sync completed successfully…"), which reads
// as fine beside "Partly working". A plain line says what is wrong first, and
// the server's text waits under Details (GUI audit B14).
function PartialMessage({ text }) {
  return (
    <>
      <p className="text-note text-muted">Some items didn't sync.</p>
      {text && (
        <details className="text-note text-muted">
          <summary className="cursor-pointer">Details</summary>
          <p className="whitespace-pre-line break-words mt-1">{text}</p>
        </details>
      )}
    </>
  )
}

function Message({ text }) {
  if (!text) return null
  const first = text.split('\n')[0]
  if (first === text && text.length <= SHORT) return <p className="text-note text-muted break-words">{text}</p>
  const cut = first.length > SHORT ? `${first.slice(0, SHORT).trimEnd()}…` : `${first}…`
  return (
    <details className="text-note text-muted">
      <summary className="cursor-pointer break-words" title={text}>{cut}</summary>
      <p className="whitespace-pre-line break-words mt-1">{text}</p>
    </details>
  )
}

export default function AssetConnectors({ panelId }) {
  const res = useApi('/api/csp/asset-connectors', { coldMs: SLOW_COLD_TIMEOUT_MS })
  const [all, setAll] = useState(false)
  const d = res.data
  const unavailable = !!res.error || d?.availability === 'error'
  const list = d?.connectors ?? []
  const quiet = list.filter((c) => QUIET.has(c.state)).length
  const shown = all ? list : list.filter((c) => !QUIET.has(c.state))
  const summary = ORDER.filter(([k]) => d?.counts?.[k]).map(([k, w]) => `${d.counts[k]} ${w}`).join(' · ')

  return (
    <Card span={6} panelId={panelId} title="Discovery connections" note="view only">
      {res.loading && !d ? (
        <Skeleton h={110} />
      ) : unavailable ? (
        <FeedUnavailable reason={d?.reason || res.error?.message} label="Connection list unavailable" onRetry={() => res.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-note text-muted">No discovery connections are set up in this account.</p>
      ) : (
        <>
          <p className="text-note text-muted mb-2">
            {summary}
            {d.truncated ? ` (the first ${list.length} are shown)` : ''}
          </p>
          <ul className="divide-y divide-line">
            {shown.map((c, i) => {
              const seen = parseSeen(c.last_sync)
              return (
                <li key={`${c.name}-${i}`} className="py-2 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-copy">
                    <span className="font-medium break-all">{c.name}</span>
                    <span className="text-note text-muted">{c.type}</span>
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full" style={{ background: DOT[c.state] || 'var(--color-other)' }} />
                      {c.word}
                    </span>
                    <span className="text-note text-muted ml-auto" title={seen ? seen.toLocaleString() : undefined}>
                      {seen ? `last sync ${seenAgo(c.last_sync)}` : 'never synced'}
                    </span>
                  </div>
                  {c.state === 'partial' ? <PartialMessage text={c.message} /> : <Message text={c.message} />}
                </li>
              )
            })}
          </ul>
          {quiet > 0 && (
            <button type="button" className="text-note underline mt-2" aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? 'Show only the ones that need a look' : `Show ${quiet} working or turned off`}
            </button>
          )}
        </>
      )}
    </Card>
  )
}
