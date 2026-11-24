// One severity, one word and one colour for each kind of problem, shared by
// every page that shows it.
//
// Until 2026-11-24 each page graded its own: zones with issues were red
// "Needs action" on DNS and amber "Review" on Daily, a subnet 98% full was red
// on Network and amber on Daily, and "Review" was red on Changes and amber
// everywhere else. A page reads its problem's severity from PROBLEM_SEV and
// its word from SEV_WORD, so two pages can no longer disagree.
//
// The grades follow the server's (go/internal/dashboard/signals.go), which is
// what Overview shows: a subnet at 90% or more is critical, a zone issue is a
// warning. Hosts not online are critical, as on Overview's open problems.
// Deletions and failed changes stay red, as their own rows on Changes are.
export const PROBLEM_SEV = {
  subnetsFull: 'crit',
  hostsDown: 'crit',
  zoneIssues: 'warn',
  changeAlarm: 'crit',
}

// The word beside a tile's number when it has a problem of that severity.
export const SEV_WORD = { crit: 'Needs action', warn: 'Review' }
