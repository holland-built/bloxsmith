// npm audit, with a short list of advisories that have NO fixed version yet.
//
// `npm audit` has no way to set one advisory aside, so a single unfixable
// advisory turns every pull request red, and a gate that is always red gets
// switched off. This reads `npm audit --json` and fails on every advisory at
// or above the floor EXCEPT the ones listed below, and each listed one stops
// counting as accepted on its `until` date, so it gets looked at again.
//
// Usage: node npm-audit-gate.mjs <audit.json> [floor] [today YYYY-MM-DD]
import { readFileSync } from 'node:fs'

// Add an entry only when the advisory has no patched version, and say why it
// cannot reach a user. Keep `until` within about six weeks.
export const ACCEPTED = {
  'GHSA-fc5q-39xc-vjpf': {
    until: '2026-12-31',
    why: 'picomatch <=4.0.7 ReDoS; no patched release exists (advisory published 2026-10-19). '
      + 'Reached only through vite build tooling, never shipped in go/web, and its globs come '
      + 'from our own vite config, not from user input.',
  },
}

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }

// Returns the advisories that should fail the build, as "<id> <severity> <package>" lines.
export function blocking(audit, floor = 'moderate', today = new Date().toISOString().slice(0, 10)) {
  const out = []
  for (const [pkg, v] of Object.entries(audit.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      // A string `via` names another package; its own advisory is checked there.
      if (typeof via === 'string') continue
      if ((RANK[via.severity] ?? 4) < RANK[floor]) continue
      const id = String(via.url ?? '').split('/').pop()
      const ok = ACCEPTED[id]
      if (ok && today <= ok.until) continue
      out.push(`${id || via.title} ${via.severity} ${pkg}${ok ? ` (accepted until ${ok.until}, now expired)` : ''}`)
    }
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, floor = 'moderate', today] = process.argv.slice(2)
  const audit = JSON.parse(readFileSync(file, 'utf8'))
  if (audit.error) {
    console.error(`npm audit did not run: ${audit.error.summary ?? JSON.stringify(audit.error)}`)
    process.exit(1)
  }
  const bad = blocking(audit, floor, today)
  for (const [id, a] of Object.entries(ACCEPTED)) console.log(`accepted: ${id} until ${a.until}: ${a.why}`)
  if (bad.length) {
    console.error(`npm audit: ${bad.length} advisory(ies) at or above ${floor}:\n  ${bad.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`npm audit: nothing at or above ${floor} outside the accepted list`)
}
