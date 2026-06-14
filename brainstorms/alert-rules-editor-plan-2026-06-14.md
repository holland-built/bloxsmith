# Plan: alert-rules-editor — 2026-06-14

**ui_change: true**
**Target files:** `index.html` only — no backend, no new files

## Already exists — do NOT recreate: `index.html`

## Steps

| # | Where | What |
|---|-------|------|
| 1 | ~2613 (near ALERT_METRICS) | Add `DEFAULT_ALERT_RULES` const — 3 rules with stable string ids, exact field shape from `add()` |
| 2 | ~3079 (root useState) | Change fallback `[]` → `DEFAULT_ALERT_RULES` in `LS.get('noc.alertRules', ...)` |
| 3 | AlertsPanel (~2643) | Add `const [editId,setEditId]=useState(null)` |
| 4 | AlertsPanel | Add `save(id)` — replaces rule in array, calls `setRules` + `LS.set`, clears editId |
| 5 | AlertsPanel table row | When `editId===r.id`: swap cells for inline selects + input, wired to Enter=save/Escape=cancel |
| 6 | AlertsPanel table row | Add ✎ button per row (before ✕); onClick → `setEditId(r.id)` + seed local edit state |

## Risk notes
- Field shape: `DEFAULT_ALERT_RULES` + `save()` must match `add()` exactly (`op`/`threshold`)
- Default seed only on empty localStorage — existing users unaffected
- No Save/Cancel buttons — keyboard only (Enter/Escape)
- Both `setRules` + `LS.set` must be called in `save()` (mirror `add()`/`del()` pattern)
