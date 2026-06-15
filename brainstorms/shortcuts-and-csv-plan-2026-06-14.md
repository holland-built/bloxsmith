# Plan: shortcuts-and-csv — 2026-06-14

**ui_change: true**
**Target files:** `index.html` only

## Already exists — do NOT recreate: `index.html`

## Steps

| # | Where | What |
|---|-------|------|
| 1 | ~3255 (near keydown handler) | Add `SECTION_EXPORT_MAP` const mapping section ids → exportNames |
| 2 | keydown handler | Add `t` key → theme cycle (with input-focus guard) |
| 3 | keydown handler | Add `e` key → `SECTION_EXPORT_MAP[section]` → querySelector click (with input-focus guard) |
| 4 | DataTable CSV button (~1290) | Add `data-export-section={exportName}` attr |
| 5 | PoliciesPanel header (~1063) | Add CSV button with `data-export-section="security-policies"`, calls `downloadCSV` |
| 6 | Shortcuts panel (~4182) | Rewrite flat list → 3 groups: Navigation / Actions / UI |

## Risk notes
- `e`/`t` must reuse existing input-focus guard (highest risk)
- Active section variable: confirm exact name used in `1–9` branch
- PoliciesPanel: CSV covers `realPolicies` + `testPolicies` combined
