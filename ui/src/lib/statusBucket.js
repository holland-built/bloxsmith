// Which of five buckets a host's status falls in: active, degraded, offline,
// unknown or other. Daily, Infra and Overview all count hosts this way, so the
// three screens give the same number for the same hosts.
//
// "unknown" is the backend's word (go/internal/dashboard/norm.go) for a host
// whose upstream status was absent or unrecognised. It used to be reported as
// "pending", a real lifecycle state an operator acts on, so it gets its own
// bucket and is never folded back into pending, active, offline or other.
export function statusBucket(s) {
  s = s || ''
  if (/^unknown$/i.test(s)) return 'unknown'
  if (/online|up|active/i.test(s)) return 'active'
  if (/degraded|warn/i.test(s)) return 'degraded'
  if (/off|down|error|fail/i.test(s)) return 'offline'
  return 'other'
}
