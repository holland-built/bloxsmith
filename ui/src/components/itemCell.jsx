import ItemLink from './ItemLink.jsx'

// A DataTable `render` for a name column: the cell's value as an ItemLink,
// clipped like a plain cell. `props(row)` adds what the row knows: the value
// to look up when it differs from the text shown, and id, space or view.
export function itemCell(kind, props = () => ({}), { mono = false } = {}) {
  return (v, r) => {
    const p = props(r) || {}
    return (
      <span className={'block overflow-hidden whitespace-nowrap text-ellipsis' + (mono ? ' font-mono' : '')} title={v == null ? undefined : String(v)}>
        <ItemLink kind={kind} value={p.value ?? v} id={p.id} space={p.space} view={p.view}>
          {v == null || v === '' ? '—' : v}
        </ItemLink>
      </span>
    )
  }
}
