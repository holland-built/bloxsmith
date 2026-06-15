# Grill-me: health-summary-card — 2026-06-15

## Decisions

| # | Question | Answer |
|---|----------|--------|
| Q1 | Sequential or parallel forge runs? | Sequential (recommendation accepted) |
| Q2 | NL query box — what's missing? | Nothing — already built. Skip. |
| Q3 | Theme persistence — build? | No — already persisted via LS. Skip. |
| Q4 | Drill-down audit — build? | No — investigation task. Skip. |
| Feature scope | What to build? | Health summary card only |

## Health card design decisions (reasonable calls, no redirect)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Placement | Top of overview section, above widget grid | First thing operator sees — job-to-be-done in <10s |
| Data sources | Subnets (critical ≥90% util), hosts (offline/error), DNS anomalies (TTL out of range), active threat feeds, active leases | All already in `data` state, zero new API calls |
| Click behavior | Clicking a metric navigates to that section | Drill-down without leaving page |
| Style | Dense strip / card row — operator-grade, not marketing | Per PRODUCT.md brand |
| "All good" state | Green strip with checkmark when no issues | Glanceable at a glance |

## Open flags

None — all branches resolved.

## Final decision — Q3

Status tile matrix already exists (lines 3756–3788). Gap: no single aggregate verdict.

**Build:** Thin status banner above the stiles:
- "✓ All systems OK" — green, when all tiles are `ok`
- "N issues detected" — red/amber, listing domains with crit/warn
- Placed immediately before the stiles `<div className="stiles">` in overview render
- Uses existing computed vars: errHostsN, critSubs, warnSubs, ttlBad, feedCrit, auditFail
- No navigation on click (stiles below handle that)
- CSS tokens only — no new colors
- ui_change: true
