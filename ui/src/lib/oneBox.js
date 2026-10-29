import { classifyIndicator } from './indicator.js'

const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$|^[0-9a-f:]+\/\d{1,3}$/i
const WANTS_ADDRESS = /\b(give|get|need|allocate|reserve|assign)\b.*\baddress(es)?\b/i
const WANTS_CHART = /\b(chart|graph|plot)\b/i

/**
 * Where the search-or-ask box sends what was typed, as a hash (no '#').
 * An IP, a CIDR or a host name is looked up; asking for an address opens the
 * address form; asking for a chart opens the chart builder; anything else is a
 * question for the AI, which arrives typed in but not sent.
 */
export function oneBoxTarget(input) {
  const q = String(input ?? '').trim()
  if (!q) return null
  if (classifyIndicator(q) || CIDR.test(q)) return { hash: `dossier?q=${encodeURIComponent(q)}`, says: 'Look it up' }
  if (WANTS_ADDRESS.test(q)) return { hash: 'selfservice', says: 'Open Get an address' }
  if (WANTS_CHART.test(q)) return { hash: 'chart', says: 'Open Build a chart' }
  return { hash: `ai?q=${encodeURIComponent(q)}`, says: 'Ask the AI' }
}

/** The question a `#ai?q=…` link carries, or ''. */
export function questionFromHash(hash) {
  const qs = String(hash ?? '').split('?')[1] || ''
  return new URLSearchParams(qs).get('q') || ''
}
