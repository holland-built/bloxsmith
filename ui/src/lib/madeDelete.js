// Delete through Made with Bloxsmith (go/internal/server/made.go): first a
// check that says whether Bloxsmith made the item, then the delete, which
// needs the code the check gave. The server refuses a delete without it, so
// the "are you sure" step cannot be skipped.
import { authFetch } from './authFetch.js'

// The kinds Bloxsmith can delete, with the word people know them by.
export const KIND_WORDS = {
  dns_record: 'DNS name',
  address: 'IP address',
  fixed_address: 'DHCP reservation',
  subnet: 'network',
  dns_zone: 'DNS zone',
  host: 'host',
  dhcp_range: 'DHCP range',
  custom_list: 'custom list',
  policy_rule: 'policy rule',
}

export const canDelete = (kind) => Object.hasOwn(KIND_WORDS, kind)

export function checkDelete(kind, id) {
  return authFetch('/api/made/delete', { method: 'POST', body: JSON.stringify({ kind, id, dry: true }) })
}

export function confirmDelete(kind, id, confirm) {
  return authFetch('/api/made/delete', { method: 'POST', body: JSON.stringify({ kind, id, dry: false, confirm }) })
}

export function when(iso) {
  const t = Date.parse(iso)
  if (!t) return ''
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// The one sentence the "are you sure" step shows.
export function whoMade(p) {
  if (p.gone) return 'It is already gone.'
  const on = p.made_on ? ` on ${when(p.made_on)}` : ''
  if (p.made) return `Made by Bloxsmith${on}. Safe to delete.`
  if (p.changed) return `Made by Bloxsmith${on}, but it has changed since. Are you sure?`
  return 'Not made by Bloxsmith. Are you sure?'
}
