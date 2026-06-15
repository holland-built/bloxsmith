# Plan: Uniform CSV Export & Column Controls Across All Tables

## Goal
Make CSV export and column controls (show/hide, reorder, expand) uniform across ALL tables in the Infoblox NOC Dashboard. 10 tables already use `DataTable + useColumns` correctly; 5 tables/table-groups need conversion.

## Single file changed
- `/Users/sholland/AI/Infoblox MCP/index.html` (single-file React SPA, in-browser Babel JSX, ~4400 lines, no build step)

`ui_change: true` — visible UI changes.

---

## Existing system — already correct, DO NOT touch
| Item | Location | Notes |
|---|---|---|
| `useColumns(widgetId, allCols)` | ~line 1218 | Manages visible cols, order, expanded state; persists to localStorage |
| `DataTable({ctl, rows, defaultRows, rowKey, initialSort, exportName, persistId, onRowClick})` | ~line 1289 | Renders column-menu button + table with sort/export |
| `ShowMoreTable` | ~line 1193 | Simple table + "show more"; leave intact (still used internally) |
| All 10 existing `useColumns`/`DataTable` tables | — | Do not change |

---

## Tables to convert

### 1. WidgetViz table mode (~line 1716)
WidgetViz renders ShowMoreTable when viz==='table'; must render DataTable + useColumns instead.
Since useColumns is a hook it cannot be called conditionally inside WidgetViz.

**Solution:** new inner component WidgetVizTable({data, columns, defaultRows, persistId}).

| Widget | Line | persistId |
|---|---|---|
| hosts | ~3895 | `widget-hosts-status` |
| subnets | ~3958 | `widget-subnets-tbl` |
| TTL | ~4021 | `widget-ttl-tbl` |
| audit | ~4044 | `widget-audit-acts` |
| security policies | ~4065 | `widget-pols-tbl` |
| feeds | ~4085 | `widget-feeds-tbl` |

### 2. Overview host drill-down (~line 3909)
Extract to HostDrillTable({hosts, onSeeAll}). persistId: drill-hosts-ov

### 3. Subnet lease drill-down (~line 3982)
Extract to LeaseDrillTable({leases, onSeeAll}). persistId: drill-sub-leases

### 4. Alert Rules table (~line 2788)
Convert to DataTable + useColumns. Actions column: nosort, fixed, noexport.
Add noexport flag support to DataTable CSV export. persistId: alert-rules

### 5. Search results table (~line 2203)
DataTable per group using g.cols as column defs. persistId: search-${g.key}

---

## Per-agent dispatch (concurrent — all read file first, edit own section only)

| Agent | Steps | Scope |
|---|---|---|
| A | 1 + 2 | WidgetVizTable component + 6 call sites |
| B | 3 + 4 | HostDrillTable + LeaseDrillTable + callsite replacements |
| C | 5 | Alert Rules conversion + noexport flag in DataTable |
| D | 6 | Search results conversion |
