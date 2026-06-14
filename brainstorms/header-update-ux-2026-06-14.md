# Grill-me: header-update-ux — 2026-06-14

## Decisions

| Q | Decision |
|---|---------|
| Update bar placement | A — version chip expands inline in header (no separate top strip) |
| Step names | Downloading → Restarting → Checking → Live |
| Post-update state | "✓ Updated to vX.Y.Z" in green ~3s then page reloads |
| Cancel button | Remove — only cancelled tracking not actual update, confusing. Keep elapsed time (small, muted). |

## What changes

- `UpdateBar` component: remove entirely (replaced by inline chip expansion)
- Version chip: when `updApplying===true`, expand to show step name + spinner + elapsed + version
- Step name map: `prepulling→Downloading`, `pulled→Downloading✓`, `recreating→Restarting`, `health→Checking`, `live→Live`
- Post-live: show "✓ Updated to vX.Y.Z" for 3s, then `window.location.reload()`
- `~5s` estimate on Recreate step: remove (no longer shown)
- CSS: remove `.upd-bar*` strip styles; add `.ver-chip-expanded` inline styles

## Open flags

None.

## Q&A log

Q1: Update bar placement → A (chip expands inline)
Q2: Step names → Downloading → Restarting → Checking → Live
Q3: Post-update state → green "✓ Updated to vX.Y.Z" ~3s then reload
Q4: Cancel + elapsed → drop cancel, keep elapsed (small/muted)
