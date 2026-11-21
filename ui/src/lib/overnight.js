import { fetchT } from './updateState.js'

// Overnight updates: GET+POST /api/update/auto (admin only).

/** The overnight settings, or null for someone who is not an admin. */
export async function loadOvernight() {
  const r = await fetchT('/api/update/auto')
  if (r.status === 403) return null
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

/** Saves the overnight settings. Resolves to the server's answer either way. */
export async function saveOvernight(body) {
  const r = await fetchT('/api/update/auto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }))
}

/** The request for an on/off or time change. */
export function overnightSaveBody(enabled, time, zone, warningShown) {
  if (!enabled) return { enabled: false }
  return { enabled: true, time, zone, ackPassphrase: !!warningShown }
}

const OVERNIGHT_TONES = {
  updated: 'text-txt',
  'no-update': 'text-dim',
  'turned-off': 'text-dim',
  'updated-locked': 'text-warn',
  'skipped-busy': 'text-warn',
  blocked: 'text-warn',
}

/** The last result as words and a colour. Anything unknown reads as a problem. */
export function overnightResult(last) {
  if (!last) return null
  return { text: last.message, tone: OVERNIGHT_TONES[last.outcome] || 'text-crit' }
}
