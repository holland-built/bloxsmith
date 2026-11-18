// Networks nobody uses: an IPv4 network of 4 addresses or more (a /30 or
// larger) whose only used addresses are the network and broadcast address.
// Same rule as unusedSubnetFilter in go/internal/dashboard/dashboard.go, which
// counts them across the whole tenant.
//
// Answers true, false, or null for "not checked". /31 and /32 have no
// network/broadcast pair, and IPv6 rows report a total of 0 (measured on the
// live tenant 2026-11-17), so this rule cannot judge them.
export function isUnused(s) {
  const cidr = Number(s?.cidr)
  if (String(s?.addr ?? '').includes(':')) return null
  if (!Number.isFinite(cidr) || cidr > 30) return null
  if (s.used == null || s.total == null || Number(s.total) < 4) return null
  return Number(s.used) === 2
}
