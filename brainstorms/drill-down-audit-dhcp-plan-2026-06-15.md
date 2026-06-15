# Opus Plan: drill-down-audit-dhcp — 2026-06-15

ui_change: true

## Target file
`/Users/sholland/AI/Infoblox MCP/index.html` — already exists, do NOT recreate.

## 6 surgical edits

1. Line 1133: AuditTable signature → add `,onDrill`
2. Line 1166: AuditTable DataTable → add `onRowClick={onDrill?l=>onDrill({type:'audit',data:l}):undefined}`
3. Line 1171: DhcpTable signature → add `, onDrill`
4. Line 1178: DhcpTable DataTable → add `onRowClick={onDrill?l=>onDrill({type:'lease',data:l}):undefined}`
5. Line 4110: DHCP call site → add `onDrill={setDrillEntity}`
6. Line 4233: Audit call site → add `onDrill={setDrillEntity}`

## DrillSheet branches (insert after line 2569, before line 2570)

lease: addr, host, state badge, subnet name, util% cross-ref
audit: full ts, user, action (actionColor), resource, result badge

## Tests (5)
- AuditTable signature has onDrill
- DhcpTable signature has onDrill  
- DrillSheet has lease branch
- DrillSheet has audit branch
- Audit call site has onDrill={setDrillEntity}

## Agents
- Agent A (Builder): function edits + DrillSheet branches in index.html
- Agent B (Call sites): call-site edits + 5 tests in test_regression.py
