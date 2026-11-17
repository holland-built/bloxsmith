import { useState } from 'react'
import { useApi } from '../lib/api.js'
import { copyText, itemActions } from '../lib/itemActions.js'
import { pageState } from '../lib/itemPaging.js'
import { ITEM_WORDS, itemHref } from '../lib/itemHref.js'
import { DASH } from '../lib/measured.js'
import ItemLink from './ItemLink.jsx'
import { Empty, FeedUnavailable, Skeleton } from './ui.jsx'

// One network, IP space, DNS zone or site: its details and what you can do
// next. Reached from a name in any table (ItemLink) as #dossier?kind=…; an
// address keeps the search ledger in DossierPage.
//
// The item is read from GET /api/item/{kind}, which answers 200 with an
// availability verdict (go/internal/server/item.go). Without an id, more than
// one match is a real answer — the same network in two IP spaces — so the
// page lists them and lets the person pick, rather than picking for them.

function pct(u) {
  const v = u && typeof u === 'object' ? u.utilization : u
  return typeof v === 'number' && isFinite(v) ? `${v}% used` : null
}

function tagsText(t) {
  if (!t || typeof t !== 'object') return null
  const s = Object.entries(t).map(([k, v]) => `${k}=${v}`).sort().join(', ')
  return s || null
}

const cidrOf = (r) => (r.address ? (r.cidr != null ? `${r.address}/${r.cidr}` : r.address) : null)

// The label a row goes by in the chooser and the heading.
function rowName(kind, r) {
  if (kind === 'network') return cidrOf(r)
  if (kind === 'space') return r.name
  if (kind === 'zone') return r.fqdn
  return null
}

// Where a row sits, said in words: "in Corp", "in default".
function rowScope(kind, r) {
  if (kind === 'network') return r.space_name || r.space || null
  if (kind === 'zone') return r.view_name || r.view || null
  return null
}

function details(kind, r) {
  if (kind === 'network') {
    return [
      ['Network', cidrOf(r)],
      ['Name', r.name],
      ['IP space', r.space ? <ItemLink key="space" kind="space" value={r.space_name || r.space} id={r.space}>{r.space_name || r.space}</ItemLink> : null],
      ['Used', pct(r.utilization)],
      ['Comment', r.comment],
      ['Tags', tagsText(r.tags)],
    ]
  }
  if (kind === 'space') {
    return [
      ['Name', r.name],
      ['Used', pct(r.utilization)],
      ['Comment', r.comment],
      ['Tags', tagsText(r.tags)],
    ]
  }
  return [
    ['Zone', r.fqdn],
    ['DNS view', r.view_name || r.view],
    ['Type', r.primary_type],
    ['Turned on', r.disabled === true ? 'No' : r.disabled === false ? 'Yes' : null],
    ['Comment', r.comment],
    ['Tags', tagsText(r.tags)],
  ]
}

// The same list the right-click menu offers (lib/itemActions.js), less Open:
// this is the page Open goes to.
function Actions({ kind, q, id, space }) {
  const [copied, setCopied] = useState('')
  const actions = itemActions({ kind, q, id, space }).filter((a) => a.key !== 'open')
  if (!actions.length) return null
  return (
    <div data-item-actions className="flex flex-wrap items-center gap-3 mt-4">
      {actions.map((a, i) =>
        a.href ? (
          <a
            key={a.key}
            href={a.href}
            className={i === 0
              ? 'px-3 py-1.5 rounded-control bg-accent text-on-accent text-copy font-medium no-underline'
              : 'text-copy text-link underline underline-offset-2'}
          >
            {a.label}
          </a>
        ) : (
          <button
            key={a.key}
            type="button"
            className="text-copy text-link underline underline-offset-2"
            onClick={() => copyText(a.copy).then((ok) => setCopied(ok ? 'Copied' : 'Could not copy'))}
          >
            {copied || a.label}
          </button>
        ),
      )}
      <span role="status" className="sr-only">{copied === 'Copied' ? `Copied ${q}` : copied}</span>
    </div>
  )
}

function DetailList({ rows }) {
  return (
    <dl data-item-details className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-copy">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="text-txt min-w-0 break-words">{v ?? <span className="text-dim">{DASH}</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

// The next page of a list, asked for by offset. Shown only while the list is
// known to be cut off, and says when the next page could not be read.
function ShowMore({ paging, busy, error, onMore }) {
  if (!paging.more) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-copy">
      <button type="button" disabled={busy} onClick={onMore} className="text-link underline underline-offset-2 disabled:opacity-50">
        {busy ? 'Loading…' : 'Show more'}
      </button>
      {error && <span role="status" className="text-note text-[var(--pill-warn-fg)]">{error}</span>}
    </div>
  )
}

export default function ItemPage({ kind, q, space, view, id }) {
  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  if (space) qs.set('space', space)
  if (view) qs.set('view', view)
  if (id) qs.set('id', id)
  const url = q || id ? `/api/item/${kind}?${qs.toString()}` : null
  const api = useApi(url)
  const body = api.data
  // Pages after the first, added by Show more. The page is remounted for
  // each item (DossierPage keys it), so these never carry over.
  const [more, setMore] = useState({ rows: [], body: null, busy: false, error: null })
  const rows = [...(Array.isArray(body?.rows) ? body.rows : []), ...more.rows]
  const paging = pageState(more.body ?? body, rows.length)
  const loadMore = () => {
    setMore((m) => ({ ...m, busy: true, error: null }))
    fetch(`${url}&offset=${rows.length}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((next) => {
        if (next?.availability !== 'ok') throw new Error(next?.reason)
        setMore((m) => ({ rows: [...m.rows, ...(next.rows || [])], body: next, busy: false, error: null }))
      })
      .catch((e) => setMore((m) => ({ ...m, busy: false, error: e?.message || 'Infoblox did not answer. Try again in a moment.' })))
  }
  const showMore = <ShowMore paging={paging} busy={more.busy} error={more.error} onMore={loadMore} />
  const word = ITEM_WORDS[kind]
  const scope = space || view
  const failed = !!api.error || (body && body.availability !== 'ok' && body.availability !== 'empty')

  let content
  if (!q && !id) content = <Empty>Nothing to show: this link names no {word.toLowerCase()}.</Empty>
  else if (api.loading) content = <Skeleton h={160} />
  else if (failed) content = <FeedUnavailable label={`Couldn't read this ${word.toLowerCase()}`} reason={body?.reason || String(api.error?.message || api.error || '')} />
  else if (body?.availability === 'empty') content = <Empty>{body.reason || `No ${word.toLowerCase()} to look up.`}</Empty>
  else if (kind === 'site') {
    content = (
      <>
        <DetailList rows={[['Site', q], ['Networks', paging.count]]} />
        {rows.length > 0 && (
          <>
            <h2 className="text-copy font-semibold mt-5 mb-2">Networks at this site</h2>
            <ul data-item-networks className="flex flex-col gap-1 text-copy">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-x-2">
                  <ItemLink kind="network" value={cidrOf(r)} id={r.id} space={r.space_name || r.space} className="font-mono" />
                  {r.name && <span>{r.name}</span>}
                  {r.space_name && <span className="text-muted">in {r.space_name}</span>}
                </li>
              ))}
            </ul>
            {showMore}
          </>
        )}
        <Actions kind={kind} q={q} />
      </>
    )
  } else if (rows.length === 0) {
    content = <Empty>No {word.toLowerCase()} called {q}{scope ? ` in ${scope}` : ''} was found in Infoblox.</Empty>
  } else if (rows.length > 1 || paging.more) {
    content = (
      <div data-item-chooser>
        <p className="text-copy mb-2">There is more than one {word.toLowerCase()} called {q} ({paging.count}). Pick one:</p>
        <ul className="flex flex-col gap-1 text-copy">
          {rows.map((r) => (
            <li key={r.id}>
              <a
                className="text-link underline underline-offset-2"
                href={itemHref({ kind, value: rowName(kind, r) || q, id: r.id, space: kind === 'network' ? r.space_name || r.space : '', view: kind === 'zone' ? r.view_name || r.view : '' })}
              >
                {rowName(kind, r) || q}
                {rowScope(kind, r) ? ` in ${rowScope(kind, r)}` : ''}
              </a>
            </li>
          ))}
        </ul>
        {showMore}
      </div>
    )
  } else {
    const r = rows[0]
    content = (
      <>
        <DetailList rows={details(kind, r)} />
        <Actions kind={kind} q={rowName(kind, r) || q} id={r.id} space={kind === 'network' ? r.space : undefined} />
      </>
    )
  }

  return (
    <div data-item-page={kind} className="ledger-cell px-[var(--sp-ledger-inset)] py-4 bg-card">
      <h1 className="text-copy font-semibold mb-4">
        {word}: <span className="font-mono">{q || id}</span>
      </h1>
      {content}
    </div>
  )
}
