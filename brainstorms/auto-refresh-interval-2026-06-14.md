# Grill-me: auto-refresh-interval — 2026-06-14

## Decisions

| Q | Decision |
|---|---------|
| Where does interval picker go? | INTO `⋯` menu — declutter toolbar |
| Countdown in toolbar? | YES — keep live "30s" countdown next to Refresh button |
| Pause button in toolbar? | YES — keep ⏸ toggle in toolbar (live action, not config) |
| Picker UI in ⋯ menu? | Inline radio rows (checkmark + label), same style as column-toggle |
| Interval options? | Unchanged: Off / 30s / 1m / 5m |

## What changes

- `RefreshControl`: remove caret + inner dropdown. Keep: Refresh button, countdown span, pause button.
- `MoreMenu`: add "Auto-refresh" section header + 4 radio rows ([Off,30s,1m,5m]) above existing rows.
- `MoreMenu` props: add `autoRefresh`, `setAutoRefresh`.
- CSS: `.auto-refresh-sel` class unused after change — can be removed.

## Open flags

None.

## Q&A log

Q1: Where to put picker? → A (⋯ menu)
Q2: Countdown keep in toolbar? → A (yes)
Q3: Pause keep in toolbar? → A (yes)
Q4: Picker UI in menu? → A (inline radio rows)
