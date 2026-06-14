# Plan: auto-refresh-interval — 2026-06-14

**ui_change: true**
**Target files:** `index.html` only — no backend, no tests, no new files

## Already exists — do NOT recreate: `index.html`

## Steps

| # | Where | What |
|---|-------|------|
| 1 | `RefreshControl` (~1366) | Remove caret button, dropdown panel, OPTS constant, caret-only open-state. Keep: Refresh button, countdown, pause button. Keep `autoRefresh` prop; drop `setAutoRefresh` if unused after edit. |
| 2 | `MoreMenu` (~1443) | Add props `autoRefresh, setAutoRefresh`. Add "Auto-refresh" section header + 4 radio rows (checkmark style matching col-toggle). Options: Off / 30s / 1m / 5m. |
| 3 | Render sites (~3645/3655) | Pass `autoRefresh` + `setAutoRefresh` to `<MoreMenu>`. Remove `setAutoRefresh` from `<RefreshControl>` if dropped. |
| 4 | Verify | Hotpatch → headless screenshot → confirm toolbar no caret, ⋯ menu has working rows |
| 5 | Changelog | Append to `DAILY_CHANGELOG.md` |

## Risk note
Confirm caret open-state in RefreshControl isn't shared with pause/hover-pause UI before deleting.
