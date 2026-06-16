# Plan: consolidate-account-key-ui — 2026-06-16

`ui_change: true`

## Target files

| File | Status |
|---|---|
| `/Users/sholland/AI/Infoblox MCP/index.html` | **already exists — do NOT recreate.** Edit TenantManager (2985–3092), topbar AcctPill usage (3706), sidebar ctx-panel guard (3669–3675). |
| `/Users/sholland/AI/Infoblox MCP/test_regression.py` | **already exists — do NOT recreate.** Add 3 new tests; fix breaking existing tests. |

## Key findings

- `headline` already declared at line 2997 (`activeAcctName||(active&&active.label)||'—'`) — just render it in trigger
- `switchKey`, `switchAccount`, `adding`, `VaultAddTenant` already in TenantManager — reuse
- **Existing tests that will break after Step 2:** lines ~1149 (`<AcctPill` rendered), ~1131 (`acct-pill-cap`), ~1143 (`Manage keys` in topbar), ~1146, ~1134/1135 (`hasKey` in AcctPill) — plan fixes these

## Ordered steps

### Step 1 — Expand TenantManager (index.html lines 2985–3092)

a. **Trigger** (line 3022): change `ctx-cap` text from `Vault` to `{'● '}{headline}` (headline already declared). Update title attr.

b. **Add unified account list** after line 2998 (component top):
```js
const allTenants = vault.vaultMode ? (vault.tenants||[]) : [];
const unified = accounts.map(a => { const t=allTenants.find(t=>t.label===a.name);
  return {name:a.name,accountId:a.id,tenantId:t?t.id:null,hasKey:!!t,isActive:a.id===activeAcct}; })
  .sort((x,y)=>(y.isActive-x.isActive)||(y.hasKey-x.hasKey)||x.name.localeCompare(y.name));
const filtered = acctSearch ? unified.filter(u=>u.name.toLowerCase().includes(acctSearch.toLowerCase())) : unified;
const showSearch = unified.length>6;
```

c. **Render account section** in main view BEFORE existing `<div className="acct-sec-label">Manage</div>`:
- Optional search input when `showSearch`
- Keyed accounts → `acct-menu-item` buttons with teal left-border style, `●`/`○`/`⟳` prefix, disabled when active/switching, onClick calls `switchKey` or `switchAccount`
- Divider between keyed/no-key when both exist
- No-key accounts → disabled gray + `+ key` button (vault mode only) → `setAdding(true)`
- `acct-sec-divider` before Manage section

d. **Wrap Manage+AI block** (3068–3086) in `{vault.vaultMode && vault.unlocked && (<>...</>)}`. Keys sub-view unchanged.

### Step 2 — Remove AcctPill from topbar (index.html line ~3706)

Delete only the `<AcctPill vault={vault} ... onManageKeys={()=>{}}/>` JSX line. **Keep `function AcctPill` definition at lines 1467–1538 intact.**

### Step 3 — Always-render TenantManager in sidebar (index.html lines 3669–3675)

Change guard from `vault&&vault.vaultMode&&(` to `accounts.length>0&&(`. Props unchanged.

### Step 4 — Update regression tests (test_regression.py)

**Add 3 new tests** (near TenantManager tests ~line 566):
- `test_tenant_manager_shows_account_name` — assert `headline` + `ctx-cap` + `● ` in TenantManager trigger
- `test_tenant_manager_has_account_list` — assert `hasKey` appears in TenantManager function slice
- `test_acct_pill_removed_from_topbar` — assert `onManageKeys={()=>{}}` absent from index.html

**Fix breaking existing tests** (lines ~1125–1149):
- Line ~1149 `assertContains("<AcctPill", ...)` → flip to assertNotIn (topbar render removed)
- Keep line ~1125 `function AcctPill(` definition check
- Re-point any `hasKey`/`Manage keys` topbar assertions to TenantManager context instead

### Step 5 — Verify

1. `python -m pytest test_regression.py -v`
2. `docker cp index.html infoblox-mcp:/app/index.html && docker restart infoblox-mcp`
3. Screenshot `_proof.png`
4. Append to `DAILY_CHANGELOG.md`

## Dispatch order

- Steps 1–3: **sequential**, single Sonnet agent (all edit index.html — no concurrent edits on one file)
- Step 4: after Steps 1–3 land (edits different file but test assertions must match new code)
- Step 5: coordinator runs last
