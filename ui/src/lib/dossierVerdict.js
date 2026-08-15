/**
 * The word a dossier's verdict shows.
 *
 * It used to be `sum.malicious ? 'Malicious' : 'Clean'`, inline in two
 * components, and that binary had no way to say the third thing a dossier can
 * be: a lookup that returned a country and a registrar and nothing that graded
 * the indicator at all. It printed "Clean" for those — a claim, made on the
 * strength of a WHOIS record (#89).
 *
 * CLEAN IS OPT-IN. `assessed === true` is required to print it. A payload
 * where the field is false, missing, or anything else — an older response
 * still in a cache, a shape this code does not recognise — prints "Not
 * assessed". That is the honest direction to be wrong in: the cost of an
 * unnecessary "Not assessed" is a second look, and the cost of an unearned
 * "Clean" is not looking at all.
 *
 * @param {object|undefined} summary the dossier's `summary` object
 * @returns {'Malicious'|'Clean'|'Not assessed'}
 */
export function dossierVerdict(summary) {
  if (summary?.malicious === true) return 'Malicious'
  if (summary?.assessed === true) return 'Clean'
  return 'Not assessed'
}

/**
 * The tone that goes with it. "Not assessed" is deliberately neither the green
 * of a clean verdict nor the red of a malicious one — a neutral state that
 * borrowed either colour would be making the same claim in a different way.
 *
 * The token names match the --pill-<tone>-bg/-fg pairs in index.css, which
 * already ship a `neutral` pair in both themes — no new colour is introduced.
 *
 * @returns {'crit'|'ok'|'neutral'}
 */
export function dossierVerdictTone(summary) {
  switch (dossierVerdict(summary)) {
    case 'Malicious':
      return 'crit'
    case 'Clean':
      return 'ok'
    default:
      return 'neutral'
  }
}
