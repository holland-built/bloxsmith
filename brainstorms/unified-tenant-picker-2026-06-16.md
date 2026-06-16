# Unified Tenant Picker — Grill-me Transcript
Date: 2026-06-16
Slug: unified-tenant-picker

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| De-duplication | Exact string match (label === name) → one row; mismatch → two rows | Name match is reliable in practice; fuzzy match too risky |
| No-key accounts | Show grayed + `+ key` affordance → opens Add Key flow | Discovery value; user sees full tenant universe |
| Click behavior | Activate stored key + auto-select matching account; fallback to first account | One-click context switch, no two-step flow |
| List location | AcctPill (topbar) only; TenantManager sidebar keeps Manage + AI | Single source of truth for switching |
| Search + Manage | Keep search (threshold >6); keep "Manage keys ›" at bottom | No regression on existing discoverability |

## Open Flags
None — all branches resolved.

## Q&A Log

Q1: De-duplication strategy when stored key label matches account name?
A: Exact match (label === name) → deduplicate into one row. No fuzzy matching.

Q2: Accounts without a stored key — show or hide?
A: Show grayed, non-clickable, with `+ key` affordance that opens Add Key flow.

Q3: Click behavior for key-backed entries?
A: Single click → activate stored key for that tenant + auto-select account whose name matches tenant label (fallback: first account). Page reloads.

Q4: Where does the unified list live?
A: AcctPill (topbar) only. TenantManager sidebar keeps Manage + AI sections (unchanged).

Q5: Search + Manage keys in unified list?
A: Keep search (threshold >6 items). Keep "Manage keys ›" link at bottom of dropdown.

## Data Model

- `vault.tenants[]` = stored API keys `{id, label}` — user-assigned names
- `vault.active` = currently active tenant id
- `accounts[]` = CSP accounts visible under current API key `{id, name}`
- `activeAcct` = currently active account id

### Unified list build algorithm
1. Start with all `accounts[]` entries
2. For each account, find matching tenant by `tenant.label === account.name`
3. For tenants with no matching account (different key), append them
4. Result: flat list where each entry has `{name, accountId?, tenantId?, isActive}`

### Entry states
| State | Visual | Clickable |
|---|---|---|
| Active (key + account match) | ● bold | no (already here) |
| Has key, not active | ○ normal | yes → switchKey(tenantId) then reload |
| No key (account only) | ○ grayed | no — shows `+ key` button |

## Key Code Locations
- `AcctPill` component: `index.html` ~line 1467
- `TenantManager` component: `index.html` ~line 2977 (do NOT touch Manage/AI sections)
- `vault.tenants`, `vault.active`, `accounts`, `activeAcct`: props passed into AcctPill
- `switchKey` async fn: currently inside TenantManager — needs extracting or duplicating into AcctPill
- `vpost('/api/vault/active', {id})`: API to activate a stored key
- `VaultAddTenant` component: opened by `+ key` affordance
