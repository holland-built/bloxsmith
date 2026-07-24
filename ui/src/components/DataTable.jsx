import { useState } from 'react'
import { useThemeColors } from '../lib/theme.jsx'
import { Card, Empty, Skeleton, utilStatus } from './ui.jsx'

// ---------- extracted shared helpers ----------

// Maps a status-ish string to a pill color (reuses utilStatus tokens). null => neutral.
export function statusBadgeColor(v) {
  const s = String(v || '').toLowerCase()
  if (/online|up|active|success|complete/.test(s)) return utilStatus(0)
  if (/degraded|warn|pending|running/.test(s)) return utilStatus(80)
  if (/off|down|error|fail/.test(s)) return utilStatus(95)
  return null
}

// Toggle a {key,dir} sort object for `key`: same key flips dir, new key => asc.
export function toggleSort(cur, key) {
  return cur && cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
}

// ---------- internals ----------

const EMPTY_MARKERS = new Set([null, undefined, '', '—', '-'])
function isEmptyCell(v) {
  return EMPTY_MARKERS.has(v)
}

function defaultCompare(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

// A column is protected from auto-hide if it carries its own render/badge/action
// or is explicitly kept — these can be meaningful even when the raw value is empty.
function isProtected(c) {
  return !!(c.keep || c.render || c.badge)
}

// Decide which columns survive auto-hide. Evaluated over the FULL sorted rows.
function visibleColumns(columns, sorted) {
  const kept = columns.filter((c) => {
    if (isProtected(c)) return true
    const values = sorted.map((r) => r[c.key])
    const nonEmpty = values.filter((v) => !isEmptyCell(v))
    if (nonEmpty.length === 0) return false // every cell empty -> hide
    if (c.hideWhenConstant) {
      const first = nonEmpty[0]
      if (nonEmpty.every((v) => v === first)) return false // all identical -> hide
    }
    return true
  })
  // Never hide the last remaining column.
  return kept.length === 0 ? columns : kept
}

// ---------- DataTable ----------

/**
 * Shared inner-table primitive. Owns thead/tbody + scroll wrapper + auto-hide +
 * cap/clip + footer + optional sort. The <Card> shell stays in the caller.
 */
export function DataTable({
  rows,
  columns,
  limit,
  viewAllHref,
  maxHeight = 320,
  rowCap = 150,
  sort,
  onSort,
  rowKey,
  onRowClick,
  rowStyle,
  stickyHeader = true,
  emptyText = 'no data',
}) {
  const theme = useThemeColors()
  const isControlled = typeof onSort === 'function'
  const [internalSort, setInternalSort] = useState(null)
  const activeSort = isControlled ? sort : internalSort

  // 1. SORT FIRST (uncontrolled only; controlled caller already sorted `rows`).
  let sorted = rows
  if (!isControlled && activeSort && activeSort.key) {
    const col = columns.find((c) => c.key === activeSort.key)
    if (col) {
      sorted = [...rows].sort((a, b) => {
        let r
        if (col.comparator) r = col.comparator(a, b)
        else {
          const av = col.sortAccessor ? col.sortAccessor(a) : a[col.key]
          const bv = col.sortAccessor ? col.sortAccessor(b) : b[col.key]
          r = defaultCompare(av, bv)
        }
        return activeSort.dir === 'asc' ? r : -r
      })
    }
  }

  // 2. VISIBLE slice.
  const visible = limit != null ? sorted.slice(0, limit) : sorted.slice(0, rowCap)

  // 3 + 4. Auto-hide over full sorted rows.
  const cols = visibleColumns(columns, sorted)

  function handleSort(key) {
    const next = toggleSort(activeSort, key)
    if (isControlled) onSort(next)
    else setInternalSort(next)
  }

  if (rows.length === 0) {
    return <div className="min-h-[100px] flex items-center justify-center text-muted text-sm">{emptyText}</div>
  }

  const headBg = stickyHeader ? 'sticky top-0 z-10 bg-card' : ''

  // table-fixed column widths: explicit width wins; badges/right-aligned numbers
  // hug small so text/mono columns keep the room; a mono clip becomes its column
  // width. Everything else shares the remaining width equally. table-fixed +
  // per-cell overflow-hidden guarantees the table never exceeds the card (no
  // horizontal scroll, ever) and the last column is never pushed off.
  const colWidth = (c) =>
    c.width || (c.badge ? '104px' : c.align === 'right' ? '84px' : c.mono && c.clip ? `${c.clip}px` : undefined)

  const table = (
    <table className="w-full table-fixed border-collapse text-sm">
      <thead>
        <tr>
          {cols.map((c) => {
            const alignRight = c.align === 'right'
            const lowPri = c.priority === 'low' ? ' @max-[360px]:hidden' : ''
            const base = `${headBg} text-[10.5px] font-medium text-dim uppercase tracking-wide py-2 px-2.5 border-b border-line-2 ${alignRight ? 'text-right' : 'text-left'}${lowPri}`
            if (c.sortable) {
              const isActive = activeSort && activeSort.key === c.key
              const ariaSort = isActive ? (activeSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
              return (
                <th key={c.key} aria-sort={ariaSort} className={base} style={colWidth(c) ? { width: colWidth(c) } : undefined}>
                  <button
                    type="button"
                    onClick={() => handleSort(c.key)}
                    className={`inline-flex items-center gap-1 uppercase tracking-wide select-none cursor-pointer hover:text-muted ${alignRight ? 'flex-row-reverse' : ''}`}
                  >
                    {c.label}
                    <span aria-hidden="true">{isActive ? (activeSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                  </button>
                </th>
              )
            }
            return (
              <th key={c.key} className={base} style={colWidth(c) ? { width: colWidth(c) } : undefined}>
                {c.label}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {visible.map((r, i) => (
          <tr
            key={rowKey ? rowKey(r, i) : `${r.id ?? r.name ?? r.created_at ?? ''}|${i}`}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            style={rowStyle ? rowStyle(r) : undefined}
            className={onRowClick ? 'cursor-pointer hover:bg-line/50' : undefined}
          >
            {cols.map((c) => {
              const v = r[c.key]
              const alignRight = c.align === 'right'
              const lowPri = c.priority === 'low' ? ' @max-[360px]:hidden' : ''
              const tdBase = `py-2 px-2.5 border-b border-line overflow-hidden ${alignRight ? 'text-right' : ''}${lowPri}`
              // 5. render -> badge -> mono -> default text.
              if (c.render) {
                return (
                  <td key={c.key} className={tdBase}>
                    {c.render(v, r)}
                  </td>
                )
              }
              if (c.badge) {
                const st = statusBadgeColor(v) || { bg: theme.pillNeutralBg, fg: theme.pillNeutralFg }
                return (
                  <td key={c.key} className={tdBase}>
                    <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: st.bg, color: st.fg }}>
                      {v || '—'}
                    </span>
                  </td>
                )
              }
              if (c.mono) {
                return (
                  <td key={c.key} className={tdBase}>
                    <span
                      className="block overflow-hidden whitespace-nowrap text-ellipsis font-mono"
                      title={v != null ? String(v) : undefined}
                    >
                      {v ?? '—'}
                    </span>
                  </td>
                )
              }
              return (
                <td key={c.key} className={tdBase}>
                  <span className="line-clamp-2" title={v != null ? String(v) : undefined}>
                    {v ?? '—'}
                  </span>
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )

  // 8. Footer.
  let footer = null
  if (limit != null && viewAllHref && rows.length > limit) {
    footer = (
      <a
        href={viewAllHref}
        className="block text-center text-accent text-[11.5px] font-medium py-2 px-2.5 hover:bg-line/50 rounded-lg transition-colors"
      >
        View all {rows.length} →
      </a>
    )
  } else if (limit == null && rows.length > rowCap) {
    footer = (
      <div className="text-center text-dim text-[11px] py-2">
        showing {rowCap} of {rows.length.toLocaleString()} — filter to narrow
      </div>
    )
  }

  // table-fixed guarantees the table fits the card, so the wrapper NEVER x-scrolls
  // (the user's #1 complaint). @container only hides priority:'low' columns at true
  // phone width (<360px). Long values clip within their fixed column via ellipsis.
  return (
    <div className="@container">
      <div className="overflow-x-hidden overflow-y-auto" style={{ maxHeight }}>
        {table}
      </div>
      {footer}
    </div>
  )
}

// ---------- FeedCard (thin Card + gates + DataTable) ----------

export function FeedCard({ span, title, note, feed, columns, limit, viewAllHref, count }) {
  const rows = feed.data?.rows ?? []
  const bad = feed.error || feed.data?.status === 'error'
  const right = count && rows.length > 0 ? <span className="text-[11px] text-muted">{rows.length.toLocaleString()}</span> : undefined

  return (
    <Card span={span} title={title} note={note} right={right}>
      {feed.loading && !feed.data ? (
        <Skeleton h={160} />
      ) : bad ? (
        <Empty>feed unavailable</Empty>
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <DataTable rows={rows} columns={columns} limit={limit} viewAllHref={viewAllHref} />
      )}
    </Card>
  )
}
