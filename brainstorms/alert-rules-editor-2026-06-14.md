# Grill-me: alert-rules-editor — 2026-06-14

## Decisions

| Q | Decision |
|---|---------|
| Edit UI style? | Inline edit — ✎ icon per row triggers in-place field editing |
| Default rules on first load? | YES — seed 2–3 defaults (offline hosts ≥ 1, critical subnets ≥ 1, audit failures ≥ 1) |
| Custom name field? | NO — metric label is the identifier |
| Inline edit save/cancel? | Enter saves, Escape cancels — no Save/Cancel buttons |

## What changes

- `AlertsPanel` (`index.html` ~2643): add `editId` state; ✎ button per row; when `editId===r.id`, cells become inline inputs; Enter → save + clear editId; Escape → clear editId
- Default seed: `LS.get('noc.alertRules', DEFAULT_RULES)` where DEFAULT_RULES has 3 preset entries
- No backend changes, no new files

## Open flags

None.

## Q&A log

Q1: Edit UI? → A (inline, ✎ icon)
Q2: Default rules? → A (yes, seed defaults)
Q3: Name field? → B (no)
Q4: Save/cancel mechanic? → C (Enter/Escape, no buttons)
