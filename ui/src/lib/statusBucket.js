// Which of five buckets a host's status falls in: active, degraded, offline,
// unknown or other. Daily, Infra and Overview all count hosts this way, so the
// three screens give the same number for the same hosts.
//
// "unknown" is the backend's word (go/internal/dashboard/norm.go) for a host
// whose upstream status was absent or unrecognised. It used to be reported as
// "pending", a real lifecycle state an operator acts on, so it gets its own
// bucket and is never folded back into pending, active, offline or other.
//
// "ok" as the whole word is online too. Some hosts report it, and until
// 2026-11-24 it fell through to "other": Infra drew such a host in purple as
// "Other" and Daily listed it as needing attention, while Overview, which
// counts only the offline ones, already treated it as online.
//
// Whole words only, never a word inside a word (2026-11-25). The old loose
// match counted "Setup failed" (it holds "up") and "Inactive" (it holds
// "active") as Active, so a broken host was drawn as a healthy one. The words
// are the ones go/internal/dashboard/norm.go sends, plus the spellings other
// feeds use; "inactive" is offline there too. A status that names a failure
// in a longer phrase ("Setup failed") is still offline. Any other word is
// "other": never Active on a guess.
const BUCKET = {
  unknown: 'unknown',
  ok: 'active', online: 'active', active: 'active', up: 'active',
  degraded: 'degraded', warning: 'degraded', warn: 'degraded',
  offline: 'offline', inactive: 'offline', down: 'offline', error: 'offline', failed: 'offline', fail: 'offline',
}

export function statusBucket(s) {
  const word = String(s ?? '').trim().toLowerCase()
  if (Object.hasOwn(BUCKET, word)) return BUCKET[word]
  if (/\b(failed|failure|error|down|offline)\b/.test(word)) return 'offline'
  return 'other'
}
