// What the Best practices page counts, kept apart from the page so it can be
// tested on its own (bestPractices.test.js).

export const SEVERITY = {
  high: { label: 'High', tone: 'crit' },
  medium: { label: 'Medium', tone: 'warn' },
  low: { label: 'Low', tone: 'none' },
}
const RANK = { high: 0, medium: 1, low: 2 }
export const sevOf = (c) => SEVERITY[c.severity] || SEVERITY.low

// Problems first, then the checks that couldn't tell, then the passed ones;
// worst severity first inside each group.
export function order(checks) {
  const group = (c) => (c.status === 'problem' ? 0 : c.status === 'passed' ? 2 : 1)
  return [...checks].sort((a, b) => group(a) - group(b) || (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3))
}

// The headline numbers, counted from the same list the rows are drawn from,
// so a tile and the list never disagree. A check with any status other than
// problem or passed is counted as couldn't tell, never as passed.
export function tally(checks) {
  const problems = checks.filter((c) => c.status === 'problem')
  const passed = checks.filter((c) => c.status === 'passed').length
  const bySev = ['high', 'medium', 'low']
    .map((s) => [s, problems.filter((c) => (SEVERITY[c.severity] ? c.severity : 'low') === s).length])
    .filter(([, n]) => n)
  return { total: checks.length, problems: problems.length, unknown: checks.length - problems.length - passed, passed, bySev }
}

// The count in front of a problem's title. The server writes it into the
// sentence ("342 on-prem hosts are offline…"); when the sentence starts with
// the number of affected items, the number is shown once, in front, and the
// rest of the sentence follows it.
export function splitCount(c) {
  const n = c.items?.length ?? 0
  const lead = `${n} `
  if (n && c.title.startsWith(lead)) return { n, rest: c.title.slice(lead.length) }
  return { n: n || null, rest: c.title }
}
