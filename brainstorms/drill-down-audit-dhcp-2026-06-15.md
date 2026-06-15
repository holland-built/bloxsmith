# Grill-me: drill-down-audit-dhcp — 2026-06-15

## Decisions

| # | Question | Answer |
|---|----------|--------|
| Q1 | Separate or combined forge run? | Combined (user said "drill down") |
| Q2 | Polish first or drill-down first? | Drill-down first (user chose) |

## Confirmed gaps (from code audit)

| Section | Table | Has onDrill? | DrillSheet type? |
|---------|-------|-------------|-----------------|
| DHCP | DhcpTable (line 1171) | ✗ | ✗ (no 'lease' type) |
| Audit | AuditTable (line 1133) | ✗ | ✗ (no 'audit' type) |
| All others | IPAMTable, HostsTable, TTLTable, FeedsTable, PoliciesPanel | ✓ | ✓ |

## Implementation decisions (reasonable calls)

| Decision | Choice |
|----------|--------|
| Lease DrillSheet fields | IP addr, hostname, state (badge), subnet name, subnet_id |
| Lease cross-reference | Find subnet by subnet_id → show util% |
| Audit DrillSheet fields | Full ts (fmtTs), user, action (colored), resource, result (badge) |
| Audit extra | No "related events by user" panel — keep consistent with other kv panels |
| Cursor style | onDrill rows get `cursor:pointer` via DataTable onRowClick |

## Files to change

- `index.html` — AuditTable, DhcpTable, DrillSheet, audit section render, DHCP section render
- `test_regression.py` — new tests for lease/audit drill

## ui_change: true
