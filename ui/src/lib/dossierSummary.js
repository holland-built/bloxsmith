// The search page's plain answer, built from what each source reported. The
// ledger below it lists every source in full; this says what they add up to,
// in words, so "none" four times is not the first thing read.
//
// states: { assets, dns, ipam } each one of ok | none | loading | error |
// unsupported | na. subnets: the rows /api/search/subnet sent, smallest
// first, or null when it was not asked or failed.

const USED_BY = { ipam: 'an IPAM record', dns: 'a DNS record', assets: 'an asset' }

export function subnetName(s) {
  const net = s?.address != null && s?.cidr != null ? `${s.address}/${s.cidr}` : null
  if (!net) return null
  return s.name ? `${net} (${s.name})` : net
}

export function dossierSummary(q, states, subnets) {
  if (!q) return null
  // A source that has not reported yet is still loading, not "none".
  if (Object.keys(USED_BY).some((k) => !states[k] || states[k] === 'loading' || states[k] === 'noquery')) return null
  const keys = Object.keys(USED_BY).filter((k) => states[k] !== 'na')
  const found = keys.filter((k) => states[k] === 'ok')
  const unknown = keys.filter((k) => states[k] !== 'ok' && states[k] !== 'none')
  // The same address can sit in a subnet in each of several IP spaces.
  const named = (subnets ?? []).map(subnetName).filter(Boolean)
  const where = named.length === 1 ? ` It's inside subnet ${named[0]}.`
    : named.length > 1 ? ` It's inside ${named.length} subnets, one per IP space: ${named.slice(0, 3).join('; ')}${named.length > 3 ? '; and more' : ''}.`
      : ''
  if (found.length) {
    const what = found.map((k) => USED_BY[k]).join(', ')
    return `${q} is in use: ${what} ${found.length === 1 ? 'mentions' : 'mention'} it.${where}`
  }
  if (unknown.length) {
    return `Nothing found for ${q} so far, but ${unknown.length === 1 ? 'one source' : `${unknown.length} sources`} could not be checked, so it may still be in use.${where}`
  }
  const lead = subnets?.length ? `${q} looks free.` : `Nothing in Infoblox uses ${q}.`
  const names = keys.map((k) => USED_BY[k].replace(/^an? /, ''))
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]
  return list ? `${lead}${where} No ${list} uses it.` : `${lead}${where}`
}
