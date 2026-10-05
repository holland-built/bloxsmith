// Where amber and red start for "how full is this", in percent used. ONE pair
// for the whole app.
//
// Until 2026-10-04 there were four. The Status tiles (and the server) said
// 70 and 90; the Status heatmap and every table badge said 75 and 92; the
// Network tiles and chart said 70 and "over 85"; Daily counted from 85. A
// subnet at 88% was amber on one page and red on the next, and one at 91% was
// counted as critical in a tile and drawn amber in the table under it.
//
// 70 and 90 are the server's numbers, and that is why they are the ones kept:
// go/internal/dashboard grades its warnings with them (signals.go), counts the
// whole network with them (dashboard.go, `utilization>=90`), and loads every
// subnet at 70 or more so the pages have the rows to draw. The owner was asked
// to choose between this pair, 75/92 and 70/85, did not, and was told this
// pair would be used.
//
// MOVING EITHER NUMBER means moving the server's as well. UTIL_WARN below 70
// would ask the pages to grade subnets the server never sent.
//
// THE AMBER BAND IS LABELLED "70–89%", and that is exact, not rounded: a
// subnet's utilisation reaches the pages as a whole number (norm.go rounds
// used/total to an integer), so nothing sits between 89 and 90.
export const UTIL_WARN = 70
export const UTIL_CRIT = 90

// 'crit' from UTIL_CRIT up, 'warn' from UTIL_WARN up, otherwise 'ok'. Both
// ends inclusive: a subnet at exactly 90% is red, as it is in the server's
// count. A value that is not a number is 'ok' here, as it always was; every
// caller that can meet one tests for it first and draws "Unknown" instead.
export function utilBand(util) {
  return util >= UTIL_CRIT ? 'crit' : util >= UTIL_WARN ? 'warn' : 'ok'
}
