import { useEffect, useMemo, useRef, useState } from 'react'
import { SLOW_COLD_TIMEOUT_MS, useApi } from '../lib/api.js'
import { mergeStateKey, nextMergeState } from '../lib/assetColumns.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, Skeleton, TabIntro, useChartTheme } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'

// The Assets tab: a searchable, filterable, paged inventory of every asset
// discovery found. Until this existed, asset data appeared only as scalar
// tiles — Security's "Asset Insights" and Infra's "Asset Discovery" — which
// could say how many there were and never which ones.
//
// WHY THIS TAB DOES NOT POLL, WHEN ALMOST EVERY OTHER ONE DOES. Security.jsx
// polls its CSP panels every 30s and that is right for a threat feed, where
// the whole point is that something new arrived. Asset inventory moves on
// discovery SYNC CYCLES, not second to second, so a poll here would spend two
// upstream cube calls every 30 seconds per open tab to redraw identical rows —
// and it would do it while the operator is mid-scroll through page 4, which is
// the one moment a table must not move under them. There is a Refresh button
// instead. (It re-requests; the server holds its own 5-minute TTL cache, so
// two refreshes inside that window legitimately return the same rows. The
// button makes no promise beyond "ask again".)
//
// WHY EVERY QUERY IS A URL. useApi refetches when its url changes, so search,
// type filter, sort and page are all just parts of a string. That is what
// keeps this component free of fetch orchestration: there is no "did the
// filter change since the request went out" bookkeeping to get wrong, because
// a stale response belongs to a url nobody is asking for any more.

const PAGE_SIZE = 50

function buildUrl({ q, type, sort, dir, page }) {
  const p = new URLSearchParams()
  if (q) p.set('q', q)
  if (type) p.set('type', type)
  p.set('sort', sort)
  p.set('dir', dir)
  p.set('page', String(page))
  return `/api/csp/assets?${p.toString()}`
}

function fmtSeen(v) {
  if (!v) return '—'
  const d = new Date(v)
  return isNaN(d) ? String(v) : d.toLocaleString()
}

// A cell that shows the value it has and an em-dash where it has none. The
// em-dash matters: several of these columns are genuinely sparse upstream
// (vendor is blank on ~19% of assets), and a blank cell reads as a rendering
// bug where "—" reads as "not recorded".
function textCell(v) {
  return <span title={v || undefined}>{v || '—'}</span>
}

export default function Assets() {
  // `input` is what is being typed; `q` is the last query actually searched.
  // Same split Audit.jsx's CSP panel uses, and for the same reason: it is the
  // only way to tell "you have not searched yet" apart from "your search
  // matched nothing", which are different things to put on screen.
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [sort, setSort] = useState({ key: 'last_seen', dir: 'desc' })
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState(null)

  const url = useMemo(
    () => buildUrl({ q, type, sort: sort.key, dir: sort.dir, page }),
    [q, type, sort, page],
  )
  // THE TWO SLOWEST READS IN THE APP, AND WHY THEY GET A LONGER LEASH.
  //
  // Both are backed by Cube.js queries against the tenant's asset store, and
  // both are cached server-side for 5 minutes (cache.TTL) with nothing keeping
  // them warm — the dashboard stays hot because ConnStatus polls it from every
  // open tab, and this tab deliberately does not poll (see FetchAssetInventory's
  // comment in go/internal/dashboard/assets.go). So any visit more than five
  // minutes after the last one pays the full cold price.
  //
  // Measured cold against the live tenant on 2026-08-10, seconds:
  //   /api/csp/assets          11.2  11.0  18.5
  //   /api/csp/asset-filters    9.4   6.9
  // against a 12s default budget. That is why the tab so often showed "Asset
  // inventory unavailable": the read had not failed, it had not finished, and
  // the browser threw away an answer the server then went on to cache — which
  // is also why hitting Refresh straight afterwards always worked and made the
  // failure look random.
  //
  // The server side of this was fixed too (the paired cube queries now run
  // concurrently rather than end to end, which took the filters read from 9.4s
  // to 6.9s), but the inventory read is one dominant query and cannot be
  // parallelised below its own latency. The remaining gap is a wait, not a
  // fault, and a wait should be waited for rather than reported as a failure.
  const list = useApi(url, { coldMs: SLOW_COLD_TIMEOUT_MS })
  const filters = useApi('/api/csp/asset-filters', { coldMs: SLOW_COLD_TIMEOUT_MS })

  // Any change to what is being asked for puts you back on page 1. Without
  // this, narrowing a 2,620-asset list to 12 while sitting on page 4 leaves
  // you on an offset past the end of the new result — an empty table that
  // looks exactly like "your filter matched nothing".
  useEffect(() => {
    setPage(0)
    setSelected(null)
  }, [q, type, sort])

  function refresh() {
    list.refetch()
    filters.refetch()
  }

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-1">Assets</h1>
      <TabIntro anchor="assets">
        Every asset discovery found, searchable by name and filterable by type. Click a row for the
        fields too sparse to keep in the table.
      </TabIntro>
      {/* The panelIds sit on the call sites, not only on the Card each wrapper
          returns: CardGrid reads panelId off its OWN direct children to apply a
          saved order, and a wrapper that keeps the id inside is invisible to
          that read. Each wrapper forwards it to its Card unchanged. */}
      <CardGrid layoutKey="assets">
        <FilterBar
          panelId="assets-filter-bar"
          filters={filters}
          type={type}
          onType={setType}
          input={input}
          onInput={setInput}
          onSearch={() => setQ(input.trim())}
          onClear={() => { setInput(''); setQ('') }}
          searched={q}
          onRefresh={refresh}
          busy={list.loading || filters.loading}
        />
        <AssetList
          panelId="assets-list"
          list={list}
          searched={q}
          type={type}
          sort={sort}
          onSort={setSort}
          page={page}
          onPage={setPage}
          selected={selected}
          onSelect={setSelected}
        />
        {/* The only conditional child in this grid, so it carries an explicit
            key as well as the panelId. Without one its key is positional, and
            Children.toArray would hand the same key to whatever child sits at
            that index once the detail panel closes. */}
        {selected && (
          <AssetDetail
            key="assets-detail"
            panelId="assets-detail"
            cqid={selected.cqid}
            row={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </CardGrid>
    </div>
  )
}

// ---------- filter bar: total + type chips ----------

// The default view is deliberately NOT a blank table waiting for a search.
// It is the real total and the type chips, so the first thing on screen tells
// you the size and shape of the estate — and every chip is a one-click way to
// ask a question, which a search box the operator has to guess at is not.
function FilterBar({ filters, type, onType, input, onInput, onSearch, onClear, searched, onRefresh, busy, panelId }) {
  const { COLORS } = useChartTheme()
  const d = filters.data
  // Two separate failure sources, and they must both land in the same state:
  // filters.error is the fetch itself dying (network, timeout, non-2xx), and
  // availability === 'error' is the server saying the upstream read failed.
  // Checking only one of them leaves the other rendering as an empty chip row,
  // which reads as "this tenant has no asset types".
  const unavailable = !!filters.error || d?.availability === 'error'
  const types = d?.types ?? []

  return (
    <Card
      span={6}
      panelId={panelId}
      title="Asset Inventory"
      note="CSP discovery"
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Search by name…"
            aria-label="Search assets by name"
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            className={`${FIELD_CLS} w-[220px]`}
          />
          <button
            type="button"
            onClick={onSearch}
            className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm"
          >
            Search
          </button>
          {searched && (
            <button
              type="button"
              onClick={onClear}
              className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-dim text-sm"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm disabled:opacity-40"
          >
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      }
    >
      {filters.loading && !d ? (
        <Skeleton h={72} />
      ) : unavailable ? (
        <FeedUnavailable reason={d?.reason || filters.error?.message} label="Asset filter feed unavailable" />
      ) : (
        <>
          <div className="mb-2">
            {/* total === null is a real state: the type query worked and the
                count query did not. It renders as no number at all, never as
                0 — see assets.go's assembleAssetFilters. */}
            {typeof d?.total === 'number' ? (
              <>
                <span className="text-lg font-semibold" style={{ color: COLORS.accent }}>
                  {d.total.toLocaleString()}
                </span>
                <span className="text-dim text-[11px] ml-1.5">assets discovered</span>
              </>
            ) : (
              <span className="text-[11px]" style={{ color: COLORS.warn }}>
                total unavailable — the count query failed, the list below did not
              </span>
            )}
          </div>
          {types.length === 0 ? (
            <div className="text-[11px] text-dim">no asset types recorded for this tenant</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {types.map((t) => {
                const active = t.label === type
                return (
                  <button
                    key={t.label}
                    type="button"
                    aria-pressed={active}
                    // Clicking the active chip clears it. A filter you can turn
                    // on and cannot turn off from the same control is the most
                    // reliable way to strand someone in a filtered view.
                    onClick={() => onType(active ? '' : t.label)}
                    className={
                      'px-2.5 py-1 rounded-full border text-[12px] ' +
                      (active
                        ? 'border-accent bg-accent text-white font-medium'
                        : 'border-border bg-field text-muted hover:text-txt')
                    }
                  >
                    {t.label}
                    {typeof t.count === 'number' && (
                      <span className={active ? 'ml-1.5 opacity-80' : 'ml-1.5 text-dim'}>{t.count.toLocaleString()}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ---------- the list ----------

function AssetList({ list, searched, type, sort, onSort, page, onPage, selected, onSelect, panelId }) {
  const d = list.data
  const unavailable = !!list.error || d?.availability === 'error'
  const rows = d?.rows ?? []
  const total = typeof d?.total === 'number' ? d.total : null
  const hasMore = d?.has_more === true

  // Provider and Vendor collapse into one column when they hold the same value
  // on every row. The decision lives in assetColumns.js, not here, because it
  // is not a property of this render: it is made once per search/type/sort
  // state and held across that state's pages, and a page that shows the two
  // differing loses the merge for good. See that file for why.
  //
  // The ref is written during render on purpose. Deriving it in an effect would
  // paint the two-column header first and merge on the following frame — a
  // visible header flicker on every page change. nextMergeState is idempotent
  // for a repeated page, so a StrictMode double-invoke lands on the same answer.
  const mergeRef = useRef(null)
  mergeRef.current = nextMergeState(mergeRef.current, mergeStateKey({ q: searched, type, sort }), rows)
  const merged = mergeRef.current.merged

  // keep: true on every column. DataTable auto-hides a column whose cells are
  // all empty, which is right for a one-shot panel and wrong for a paged one:
  // a page where nobody happens to have a vendor recorded would silently drop
  // the Vendor column, and the header would change shape as you page. A stable
  // column set is worth the occasional column of em-dashes.
  const columns = [
    { key: 'name', label: 'Name', sortable: true, keep: true, grow: true, render: textCell },
    { key: 'type', label: 'Type', sortable: true, keep: true, badge: true },
    // The merged column keeps the `provider` key. Both keys are server-side
    // sortable (assets.go assetSortDims whitelists provider and vendor alike),
    // so this is not a capability limit — it is that a merged column must sort
    // by one of the two, and picking `provider` keeps the sort key stable when
    // a later page unmerges the column back into two.
    ...(merged
      ? [{ key: 'provider', label: 'Provider / Vendor', sortable: true, keep: true, render: textCell }]
      : [
          { key: 'provider', label: 'Provider', sortable: true, keep: true, render: textCell },
          { key: 'vendor', label: 'Vendor', sortable: true, keep: true, render: textCell },
        ]),
    {
      key: 'last_seen',
      label: 'Last seen',
      sortable: true,
      keep: true,
      mono: true,
      render: (v) => (
        <span className="block overflow-hidden whitespace-nowrap text-ellipsis font-mono text-[12px]">{fmtSeen(v)}</span>
      ),
    },
  ]

  // Sorting is server-side, so this only re-points the url. DataTable is in
  // controlled mode (onSort supplied) and will NOT re-sort the rows locally —
  // which is the point: sorting 50 rows in the browser would order the page,
  // not the 2,620 assets the page is a window onto.
  function handleSort(next) {
    onSort((cur) => (cur.key === next.key ? { key: cur.key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key: next.key, dir: 'desc' }))
  }

  const from = page * PAGE_SIZE + 1
  const to = page * PAGE_SIZE + rows.length

  return (
    <Card
      span={6}
      // The one card in the app that opts out of content-driven width: this is
      // the page's primary table, not a dashboard panel, so it takes the full
      // six tracks it declares rather than shrinking to its columns.
      fit={false}
      panelId={panelId}
      title="Assets"
      right={
        rows.length > 0 && (
          <span className="text-[11px] text-muted">
            {from.toLocaleString()}–{to.toLocaleString()}
            {total != null ? ` of ${total.toLocaleString()}` : ''}
          </span>
        )
      }
    >
      {list.loading && !d ? (
        <Skeleton h={320} />
      ) : unavailable ? (
        // The whole reason this branch is separate from the one below: a feed
        // that could not be read must never render as a tenant with no assets.
        <FeedUnavailable reason={d?.reason || list.error?.message} label="Asset inventory unavailable" />
      ) : rows.length === 0 ? (
        <Empty>{searched || type ? 'no assets match' : 'no assets discovered for this tenant'}</Empty>
      ) : (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowCap={PAGE_SIZE}
            maxHeight={480}
            stickyHeader
            sort={sort}
            onSort={handleSort}
            rowKey={(r) => r.cqid}
            onRowClick={onSelect}
            rowStyle={(r) => (selected && r.cqid === selected.cqid ? { background: 'var(--color-line)' } : undefined)}
          />
          <Pager
            page={page}
            onPage={onPage}
            hasMore={hasMore}
            total={total}
            loading={list.loading}
          />
        </>
      )}
    </Card>
  )
}

// Paging is server-side and offset-based. `hasMore` is what drives Next when
// the total is unknown (a failed count query still leaves a usable list); when
// the total IS known, the last page is the one whose end reaches it. Both are
// checked, so Next is offered when either says there is more.
function Pager({ page, onPage, hasMore, total, loading }) {
  const knownMore = total != null && (page + 1) * PAGE_SIZE < total
  const next = hasMore || knownMore
  const pages = total != null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null
  const btn = 'px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      <span className="text-[11px] text-dim mr-auto">
        Page {page + 1}
        {pages != null ? ` of ${pages.toLocaleString()}` : ''}
      </span>
      <button type="button" className={btn} disabled={page === 0 || loading} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <button type="button" className={btn} disabled={!next || loading} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </div>
  )
}

// ---------- row detail ----------

// The fields here are the second budget of six cube dimensions (the cube
// blocks a seventh outright), fetched per row rather than per page. os is the
// reason this panel exists at all: it is blank on 72% of assets, so it costs
// a table column almost nothing is in — but on the one asset someone clicked,
// it is often the first thing they wanted.
function AssetDetail({ cqid, row, onClose, panelId }) {
  const detail = useApi(`/api/csp/asset-detail?cqid=${encodeURIComponent(cqid)}`)
  const d = detail.data
  const unavailable = !!detail.error || d?.availability === 'error'

  const fields = [
    ['OS', d?.detail?.os],
    ['IP addresses', d?.detail?.ip_addresses],
    ['MAC addresses', d?.detail?.mac_addresses],
    ['Model', d?.detail?.model],
    ['Location', d?.detail?.location],
  ]

  return (
    <Card
      span={6}
      panelId={panelId}
      // The heading is whichever device is open, so it is a fine heading and a
      // useless NAME: the popup's row would change every time a different row
      // was clicked, and would fall back to the raw "assets-detail" for a
      // device carrying neither a name nor a cqid.
      panelName="Asset Detail"
      title={row.name || row.cqid}
      note="asset detail"
      right={
        <button type="button" onClick={onClose} className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm">
          Close
        </button>
      }
    >
      {detail.loading && !d ? (
        <Skeleton h={110} />
      ) : unavailable ? (
        <FeedUnavailable reason={d?.reason || detail.error?.message} label="Asset detail unavailable" />
      ) : d?.availability === 'empty' ? (
        // Distinct from the failure above on purpose: the lookup ran and the
        // asset was not there. An asset can be decommissioned between the page
        // load and the click, and telling someone the feed broke when the
        // machine was simply deleted sends them debugging the wrong thing.
        <Empty>this asset no longer exists — it was removed since the list loaded</Empty>
      ) : (
        <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10.5px] text-dim uppercase tracking-wide">{label}</dt>
              {/* "not recorded", not a blank: these fields are sparse upstream
                  and the difference between "we know it has none" and "nobody
                  wrote one down" is worth the four extra words. */}
              <dd className="text-sm break-words">{value || <span className="text-dim">not recorded</span>}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  )
}
