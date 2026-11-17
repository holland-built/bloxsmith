// Where a name in a table links to: that item's own page, #dossier?kind=…
//
// An item is named by its value AND its scope. The same network can sit in
// two IP spaces and the same zone name in two DNS views, so space and view
// travel in the link whenever the row knows them. id travels only when the
// row has the real object id; it is never made up, because the page reads an
// object by id and a guessed one would read nothing (or the wrong thing).
//
// Pure, so node --test can check every shape without a browser.
import { classifyIndicator } from './indicator.js'

export const ITEM_KINDS = ['network', 'space', 'zone', 'site', 'address']

// What each kind is called on screen.
export const ITEM_WORDS = {
  network: 'Network',
  space: 'IP space',
  zone: 'DNS zone',
  site: 'Site',
  address: 'Address',
}

const clean = (v) => (v == null ? '' : String(v).trim())

// A placeholder a table prints for "nothing here" is not a name to link.
const BLANKS = new Set(['', '—', '–', '-'])

/** The hash for one item, or null when there is nothing to link to. */
export function itemHref({ kind, value, id, space, view } = {}) {
  const q = clean(value)
  if (!ITEM_KINDS.includes(kind) || BLANKS.has(q)) return null
  const p = new URLSearchParams()
  p.set('kind', kind)
  p.set('q', q)
  if (clean(space)) p.set('space', clean(space))
  if (clean(view)) p.set('view', clean(view))
  if (clean(id)) p.set('id', clean(id))
  return `#dossier?${p.toString()}`
}

/**
 * What the item page should show, read from its hash params.
 *
 * An old #dossier?q= link has no kind: an address/size becomes a network page
 * and anything else stays the search page it always was (kind 'address').
 */
export function parseItem(params = {}) {
  const q = clean(params.q)
  let kind = ITEM_KINDS.includes(params.kind) ? params.kind : null
  if (!kind) kind = classifyIndicator(q)?.kind === 'cidr' ? 'network' : 'address'
  return { kind, q, space: clean(params.space), view: clean(params.view), id: clean(params.id) }
}
