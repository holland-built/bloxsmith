# Unified Tenant Picker — Opus Plan
Date: 2026-06-16
Slug: unified-tenant-picker

## Summary
Target file: `/Users/sholland/AI/Infoblox MCP/index.html` — already exists, do NOT recreate.
Scope: `AcctPill` function only (lines 1467–1530). No backend, no other components.
`ui_change: true`

## Implementation Steps (single Sonnet agent)

1. **Add state** — after `const [switchingKey, ...]`:
   `const [adding, setAdding] = React.useState(false);`

2. **Build unified list** — replace `otherTenants`/`filteredAccts`/`filteredTenants` with:
   ```js
   const allTenants = vault.tenants || [];
   const unified = accounts.map(a => {
     const t = allTenants.find(t => t.label === a.name);
     return { name: a.name, accountId: a.id, tenantId: t ? t.id : null, hasKey: !!t, isActive: a.id === activeAcct };
   }).sort((x,y) => (y.isActive - x.isActive) || (y.hasKey - x.hasKey) || x.name.localeCompare(y.name));
   const filtered = acctSearch ? unified.filter(u => u.name.toLowerCase().includes(acctSearch.toLowerCase())) : unified;
   const showSearch = unified.length > 6;
   ```

3. **Replace menu body** — one flat `filtered.map(u => ...)` list:
   - Active (`u.isActive`): `acct-menu-item active`, prefix `●`, onClick `handleSwitchAcct(u.accountId)`
   - Has key, not active (`u.hasKey && !u.isActive`): `acct-menu-item`, prefix `○`, onClick `switchKey(u.tenantId)`, show `⟳` when switching, `disabled={!!switchingKey}`
   - No key (`!u.hasKey`): disabled button grayed `color:var(--gray-400)` + small `+ key` button (stop propagation) → `setAdding(true)`
   - Remove "This login" / "Other logins" section labels and divider between them
   - Keep `acct-search` (when `showSearch`) and `Manage keys ›` at bottom

4. **VaultAddTenant inline** — read VaultAddTenant's actual prop signature first, then:
   - When `adding === true`, render VaultAddTenant in place of the list
   - `onDone` → `setAdding(false); window.location.reload()`
   - `onCancel` → `setAdding(false)`

## Flags
- `ui_change: true`
- One Sonnet agent, one file
- VaultAddTenant prop names must be verified by reading the component before wiring
