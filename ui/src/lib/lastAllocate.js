// The IP space and subnet of the last address handed out, per tenant, so the
// next "Get an address" starts there. Kept in this browser only. Saved after a
// successful Allocate, never on a mere pick, and only restored when both ids
// are still in the lists the form loads, so a deleted subnet is never picked.

const KEY = 'bloxsmith.allocate.last'

// One entry per tenant, so switching accounts does not lose the other's pick.
function readAll() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export function readLast(tenant) {
  if (!tenant) return null
  const v = readAll()[tenant]
  return v && typeof v.space === 'string' && typeof v.subnet === 'string' ? { tenant, space: v.space, subnet: v.subnet } : null
}

export function saveLast(tenant, space, subnet) {
  if (!tenant || !space || !subnet) return
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [tenant]: { space, subnet } }))
  } catch {
    // Storage off or full: the form just starts empty next time.
  }
}

/** The stored pick, if its id is one of `ids`; else ''. */
export const stillThere = (id, ids) => (id && ids.includes(id) ? id : '')
