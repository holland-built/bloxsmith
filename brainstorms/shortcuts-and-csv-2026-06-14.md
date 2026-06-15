# Grill-me: shortcuts-and-csv — 2026-06-14

## Decisions

| Q | Decision |
|---|---------|
| Shortcuts: what's missing? | C — grouped categories + new `t` (theme) and `e` (export) bindings |
| CSV scope? | A/C — add CSV to PoliciesPanel + `e` key section-aware export |
| Shortcuts panel layout? | B — grouped (Navigation / Actions / UI), document existing + add `t`/`e` |
| `e` export target? | A — section-aware: maps section id → first table's export |

## What changes

### Keyboard shortcuts panel (index.html)
- Rewrite shortcut list as 3 groups: **Navigation** / **Actions** / **UI**
- Add `t` → theme cycle to keydown handler
- Add `e` → section-aware CSV export to keydown handler
- Section → export map: ipam→subnets, dhcp→dhcp-leases, dns→ttl-anomalies, security→security-policies, threats→threat-feeds, audit→audit-logs, hosts→hosts, insights→soc-insights, actions→iq-actions
- Mechanism: add `data-export-section={exportName}` attr to DataTable CSV button; `e` key does `document.querySelector('[data-export-section="..."]')?.click()`

### PoliciesPanel CSV (index.html)
- Add "CSV" button to PoliciesPanel header using existing `downloadCSV()` with columns: name, action, rules, active, created
- Add `data-export-section="security-policies"` attr so `e` key works on Security section

### No backend changes, no new files

## Open flags
None.

## Q&A log
Q1: Shortcuts missing? → C (groups + new bindings)
Q2: CSV scope? → A/C (PoliciesPanel + e key)
Q3: Shortcuts layout? → B (grouped, document existing, add t/e)
Q4: e key target? → A (section-aware)
