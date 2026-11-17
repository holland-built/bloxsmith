// What you can do next with one item. A small pure map so the item page and,
// later, the right-click menu offer the same actions with the same words.
//
// Each action is { key, label } plus either href (a link) or copy (the text
// to put on the clipboard). "Open in Editor" needs the real object id, so an
// item without one does not get it.

// Which Editor form edits each kind. Spaces, sites and addresses have none.
const EDITOR_TYPE = { network: 'subnet', zone: 'dns_zone' }

// What the Editor's own search box should be filled with, so the deep link's
// search finds the item (Editor.jsx FindExisting): a subnet by its address,
// a zone by its name without the root dot.
function editorQuery(kind, q) {
  if (kind === 'network') return q.split('/')[0]
  if (kind === 'zone') return q.replace(/\.$/, '')
  return q
}

export function itemActions({ kind, q, id } = {}) {
  const value = q == null ? '' : String(q).trim()
  if (!value) return []
  const out = []
  const type = EDITOR_TYPE[kind]
  if (type && id) {
    out.push({
      key: 'editor',
      label: 'Open in Editor',
      href: `#editor?type=${type}&id=${encodeURIComponent(id)}&q=${encodeURIComponent(editorQuery(kind, value))}`,
    })
  }
  out.push({ key: 'copy', label: 'Copy', copy: value })
  return out
}
