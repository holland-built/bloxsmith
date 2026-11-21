// Which trial look of the app's frame is on: ?shell=a, b or c. Anything else
// means no look, and the app draws exactly what it always has.
//
// A plain .js module because `npm test` is bare `node --test`.

export const SHELL_LOOKS = [
  { id: 'a', label: 'Focused' },
  { id: 'b', label: 'Command Bar' },
  { id: 'c', label: 'Side Rail' },
]

export function parseShell(search) {
  const v = new URLSearchParams(search || '').get('shell')
  return SHELL_LOOKS.some((l) => l.id === v) ? v : null
}

/** The link to a look (null for today's), keeping other params and the page. */
export function shellHref(id, search, hash) {
  const q = new URLSearchParams(search || '')
  if (id) q.set('shell', id)
  else q.delete('shell')
  const s = q.toString()
  return `${s ? `?${s}` : location_path()}${hash || ''}`
}

// With no query left the link still has to leave the current one.
function location_path() {
  return typeof location === 'undefined' ? '/' : location.pathname
}

export const shellLook = typeof location === 'undefined' ? null : parseShell(location.search)

if (shellLook) document.documentElement.setAttribute('data-shell', shellLook)
