// What colour a free-text status word earns.
//
// The table cell that shows a status ("online", "Setup failed", "inactive")
// has only the word to go on, and until 2026-10-03 it looked for healthy words
// anywhere inside it, healthy first:
//
//   "Setup failed"     green   "up" is in "setup"
//   "Backup error"     green   "up" is in "backup"
//   "Not supported"    green   "up" is in "supported"
//   "Inactive"         green   "active" is in "inactive"
//   "Unsuccessful"     green   "success" is in "unsuccessful"
//   "Incomplete"       green   "complete" is in "incomplete"
//
// Each of those painted a failure, or a state that is not healthy, in the one
// colour that tells an operator to look elsewhere. Two changes fix all six:
// a word has to START with the stem, so a prefix in front of it (in-, un-,
// set-, back-) stops the match; and bad is tested before good, so a status
// that says both ("online, degraded") is not painted by its better half.
//
// A word that is negated, or counted as zero, does not count either: "no
// errors", "not active" and "0 failed" each say the opposite of the word they
// contain. They earn no colour rather than the opposite one, because "not
// active" is not a claim that something is broken.
//
// A word this does not recognise earns no colour. That is deliberate: a grey
// badge says "the app does not know what this means", which is true, where a
// guess in either direction would be a claim.
//
// Plain .js so `npm test` (bare node --test) can import it; DataTable.jsx maps
// the tone onto the pill tokens.

const CRIT = ['offline', 'error', 'fail', 'unsuccess', 'shutdown']
const CRIT_EXACT = ['off', 'down']
const WARN = ['degrad', 'warn']
const WARN_EXACT = ['pending', 'running']
const OK = ['success', 'complet']
const OK_EXACT = ['online', 'up', 'active']

const NEGATION = ['no', 'not', 'non', 'never', 'without', '0']

// `counted` is for the bad words, which are also things a status counts:
// "errors: 0" is no errors. A healthy word is not a count, so a zero after one
// belongs to something else ("up 0 days") and does not undo it.
const hit = (words, stems, exact, counted) => words.some((w, i) => {
  if (!exact.includes(w) && !stems.some((s) => w.startsWith(s))) return false
  // "no errors", "0 failed" before the word; "errors: 0" after it.
  return !NEGATION.includes(words[i - 1]) && !(counted && words[i + 1] === '0')
})

/** 'crit' | 'warn' | 'ok' | null for a status string. */
export function statusTone(v) {
  const words = String(v ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (hit(words, CRIT, CRIT_EXACT, true)) return 'crit'
  if (hit(words, WARN, WARN_EXACT, true)) return 'warn'
  if (hit(words, OK, OK_EXACT, false)) return 'ok'
  return null
}
