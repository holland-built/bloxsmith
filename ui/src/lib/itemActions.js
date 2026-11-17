// What you can do next with one item. One pure list, so the item page's
// buttons and the right-click menu (components/ItemMenu.jsx) offer the same
// actions with the same words.
//
// Each action is { key, label } plus either href (a link to a job that
// already exists, with the item's details filled in) or copy (the text to put
// on the clipboard). Nothing here writes to Infoblox: every job still shows
// Preview and waits for the person to press Apply or Build.
import { classifyIndicator } from './indicator.js'
import { itemHref } from './itemHref.js'

// The kinds a name opens a menu on. A site keeps its plain link.
export const MENU_KINDS = ['space', 'block', 'network', 'address', 'zone']

const clean = (v) => (v == null ? '' : String(v).trim())
const BLANKS = new Set(['', '—', '–', '-'])

// "#tab?k=v&…", leaving out what is not known.
function hashFor(tab, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => clean(v) !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(clean(v))}`)
    .join('&')
  return qs ? `#${tab}?${qs}` : `#${tab}`
}

// The Editor's own search box text, so its deep link finds the item
// (Editor.jsx FindExisting): a range by its address, a zone without the root dot.
const bareAddress = (q) => q.split('/')[0]
const bareZone = (q) => q.replace(/\.$/, '')

const isSpaceId = (s) => clean(s).startsWith('ipam/ip_space/')
const isIP = (q) => ['ipv4', 'ipv6'].includes(classifyIndicator(q)?.kind)

export function itemActions({ kind, q, id, space } = {}) {
  const value = clean(q)
  if (BLANKS.has(value)) return []
  const copy = { key: 'copy', label: 'Copy', copy: value }

  if (kind === 'space') {
    const s = clean(id) || value
    return [
      { key: 'open', label: 'Open', href: itemHref({ kind, value, id }) },
      { key: 'network', label: 'Add a network here', href: hashFor('automate', { job: 'network', space: s }) },
      { key: 'site', label: 'Build a site here', href: hashFor('automate', { job: 'branch', space: s }) },
      { key: 'overlaps', label: 'Show overlaps', href: hashFor('network', { overlaps: s, focus: 'overlaps' }) },
    ]
  }
  if (kind === 'block') {
    // "Build a site here" is left out: a site build takes its address block
    // from the site template, so no job can be told to use this one.
    return [
      { key: 'open', label: 'Open', href: hashFor('editor', { type: 'address_block', id, q: bareAddress(value) }) },
      { key: 'network', label: 'Add a network inside', href: hashFor('automate', { job: 'network', space, block: clean(id) || value }) },
      copy,
    ]
  }
  if (kind === 'network') {
    const where = { space, subnet: id, network: value }
    return [
      { key: 'open', label: 'Open', href: itemHref({ kind, value, id, space }) },
      { key: 'ip', label: 'Get a free address', href: hashFor('automate', { job: 'ip', ...where }) },
      { key: 'reserve', label: 'Reserve an address', href: hashFor('selfservice', { ...where, reserve: '1' }) },
      // The Editor sends its IP space box to Infoblox as typed, which needs an id.
      { key: 'range', label: 'Add a DHCP range', href: hashFor('editor', { type: 'dhcp_range', space: isSpaceId(space) ? space : '' }) },
      { key: 'edit', label: 'Edit', href: hashFor('editor', { type: 'subnet', id, q: bareAddress(value) }) },
      copy,
    ]
  }
  if (kind === 'address') {
    return [
      { key: 'open', label: 'Open', href: itemHref({ kind, value }) },
      // A host record with this address reserves it in IPAM. A host name has no address to reserve.
      ...(isIP(value) ? [{ key: 'reserve', label: 'Reserve it', href: hashFor('editor', { type: 'host', addresses: value }) }] : []),
      copy,
    ]
  }
  if (kind === 'zone') {
    return [
      { key: 'open', label: 'Open', href: itemHref({ kind, value, id }) },
      { key: 'record', label: 'Add a record', href: hashFor('automate', { job: 'dns', zone: bareZone(value), zone_id: id }) },
      { key: 'edit', label: 'Edit', href: hashFor('editor', { type: 'dns_zone', id, q: bareZone(value) }) },
      copy,
    ]
  }
  if (kind === 'site') return [{ key: 'open', label: 'Open', href: itemHref({ kind, value }) }, copy]
  return []
}

// Puts text on the clipboard. navigator.clipboard needs a secure page (https
// or localhost); on plain http, as on a LAN install, the old copy command is
// the fallback. Resolves true when the text was copied.
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the copy command
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
