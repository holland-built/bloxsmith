# Grill-me: Uniform Table Controls
Date: 2026-06-15
Slug: uniform-table-controls

## Decisions

| Question | Answer |
|---|---|
| Mini drill-down panels (Overview host 15-row, Subnet lease 20-row) | Full controls |
| WidgetViz table mode | Full controls — DataTable + useColumns |
| Alert Rules table (editable config) | Full controls |
| Search results table (1-col highlight, has CSV per group) | Full controls |

## Tables Already Compliant (no changes needed)
- TTLTable (`useColumns('ttl')`)
- FeedsTable (`useColumns('feeds')`)
- AuditTable (`useColumns('audit')`)
- DhcpTable (`useColumns('dhcp')`)
- DnsAnalyticsPanel (`useColumns('dns-clients')`)
- InsightsPanel (`useColumns('insights')`)
- ActionsPanel (`useColumns('actions')`)
- HostMetricsTable (`useColumns('hostmetrics')`)
- IpamTable (`useColumns('ipam')`)
- HostsTable (`useColumns('hosts')`)

## Tables In Scope (need conversion)

### 1. WidgetViz table mode — index.html ~line 1716
WidgetViz is used for widget alt-views (bar/line/table/raw). When viz='table' it uses ShowMoreTable.
Must become DataTable + useColumns. Need a sub-component `WidgetVizTable` (hooks must be at top level).

Call sites and proposed persistIds:
- hosts widget status rows → `widget-hosts-status`
- subnets widget subRows → `widget-subnets-tbl`
- TTL widget anomaly zones → `widget-ttl-tbl`
- audit widget action counts → `widget-audit-acts`
- security policies widget → `widget-pols-tbl`
- feeds widget → `widget-feeds-tbl`

### 2. Overview host drill-down — index.html ~line 3909
Raw `<table>` inside an IIFE. Columns: Hostname, IP, Type. Max 15 rows.
Must extract to a component (or use DataTable inline). persistId: `drill-hosts-overview`

### 3. Subnet lease drill-down — index.html ~line 3982
Raw `<table>` inside drill panel. Columns: IP Address, Hostname, State. Max 20 rows.
Must extract to a component. persistId: `drill-subnet-leases`

### 4. Alert Rules table — index.html ~line 2788
Editable config table. Columns: Status, Metric, Condition, Current, (edit/delete actions).
Has inline edit mode per row. Must preserve edit functionality via render functions.
persistId: `alert-rules`
Note: actions column (edit/delete buttons) should be `nosort:true, fixed:true` and excluded from CSV export.

### 5. Search results table — index.html ~line 2203
Per-group single-column highlight display. Already has CSV button per group.
Each group (subnets, zones, hosts, etc.) has different underlying columns.
Convert to DataTable showing actual entity fields per group, not just the formatted string.
This is the most complex conversion — each group needs its own column definition.

## Open Flags
- Alert Rules inline edit: render functions in DataTable need to handle the `editId` state check
- Search results: need per-group column definitions matching the entity shape
- WidgetViz: `useColumns` hook must be in a sub-component, not called conditionally
