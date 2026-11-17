// What a job was opened with from a name's menu (lib/itemActions.js), read
// from the hash: #automate?job=ip&space=…&subnet=…&network=…, and the same
// words on #selfservice. Filling a job in never runs its Preview.
import { useApi } from './api.js'

// An IP space named by id or by name, as the menu sends whichever it knew.
export function findSpace(spaces, want) {
  const w = String(want || '').trim()
  if (!w) return null
  return (spaces || []).find((s) => s.id === w) || (spaces || []).find((s) => (s.name || '').toLowerCase() === w.toLowerCase()) || null
}

// "10.1.0.0/24" for a subnet or block row from /api/ipam/*.
export const cidrText = (r) => (r?.address ? `${r.address}${r.cidr != null && r.cidr !== '' ? `/${r.cidr}` : ''}` : '')

// A row from a list picked by id, or else by its address.
export function findRange(rows, want) {
  const w = String(want || '').trim()
  if (!w) return null
  return (rows || []).find((r) => r.id === w) || (rows || []).find((r) => cidrText(r) === w) || null
}

// A name in a table usually knows its network's id but not its IP space, and
// the jobs list networks one space at a time. The item lookup the network's
// own page uses fills the space in. `pending` is true while it is asked, so a
// job does not pick a space of its own meanwhile.
export function useNetworkPrefill({ space, subnet, network } = {}) {
  const need = !space && !!(subnet || network)
  const url = need
    ? `/api/item/network?${subnet ? `id=${encodeURIComponent(subnet)}` : `q=${encodeURIComponent(network)}`}`
    : null
  const api = useApi(url)
  const rows = api.data?.availability === 'ok' && Array.isArray(api.data.rows) ? api.data.rows : []
  const row = rows.length === 1 ? rows[0] : null
  return {
    space: space || row?.space || '',
    subnet: subnet || row?.id || '',
    pending: need && !api.error && !api.data,
  }
}
