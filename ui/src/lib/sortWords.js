// The words the phone Sort by picker puts after a column's name, so each
// choice says which way the list will run (GUI audit R3-B1, R3-C4). It said
// "Time" and "Time, reversed", and "reversed" does not say newest or oldest.
//
// The direction is worked out from the column, because the tables do not say
// what kind of value they hold:
//   - a time (its name says so, or its values are dates): oldest / newest first;
//     an end date: soonest / latest first
//   - a severity, priority or status the table ranks (comparator or accessor): most / least serious first
//     (every such comparator in tabs/ puts the most serious first)
//   - a number (or digits in text), or an address: lowest / highest first
//   - anything else is text: A to Z / Z to A
//
// Plain .js so `npm test` (bare node --test) can import it.

const TIME = /\b(time|seen|date|when|age|updated|created|detected)\b/i
const ENDS = /^ends$/i
const RANKED = /\b(severity|priority|status)\b/i
const ADDRESS = /^(ip|address)$/i

function firstValue(col, rows) {
  for (const r of rows ?? []) {
    const v = col.sortAccessor ? col.sortAccessor(r) : r?.[col.key]
    if (v != null && v !== '') return v
  }
  return null
}

const looksLikeNumber = (v) => typeof v === 'number' || (typeof v === 'string' && /^-?[\d,]+(\.\d+)?%?$/.test(v.trim()))
const looksLikeAddress = (v) => typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}\b/.test(v)
const looksLikeDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))

/** [ascending label, descending label] for one sortable column. */
export function sortWords(col, rows) {
  const v = firstValue(col, rows)
  let pair = ['A to Z', 'Z to A']
  if (ENDS.test(col.label)) pair = ['soonest first', 'latest first']
  else if (TIME.test(col.label) || looksLikeDate(v)) pair = ['oldest first', 'newest first']
  else if ((col.comparator || col.sortAccessor) && RANKED.test(col.label)) pair = ['most serious first', 'least serious first']
  else if (looksLikeNumber(v) || looksLikeAddress(v) || (col.comparator && ADDRESS.test(col.label))) pair = ['lowest first', 'highest first']
  return pair.map((w) => `${col.label}, ${w}`)
}
