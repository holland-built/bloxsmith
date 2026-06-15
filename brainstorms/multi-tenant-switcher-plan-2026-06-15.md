# Plan: multi-tenant-switcher — 2026-06-15 (revised)

**ui_change: true**
**Target files:** `index.html` only (+ test_regression.py appends)

## Already exists — do NOT recreate
- `index.html` — add AcctPill component + CSS + toolbar wire only
- `server.py` — no changes; `/api/accounts`, `/api/switch-account`, `/api/vault/active` already exist
- `test_regression.py` — append tests only

Reuse (do NOT recreate): `MoreMenu`, `TenantManager`, `accounts`/`activeAcct`/`switchAcct`/`switchingAcct` state, `vault.vaultMode`/`vault.tenants`/`vault.active`, `vpost()`, `.acct-menu`/`.acct-menu-item`/`.acct-overlay`/`.acct-search`/`.acct-sec-label`/`.acct-sec-divider` CSS.

## Steps (batches)

### Batch A — CSS (1 agent, independent)
Add near line 305:
- `.acct-pill` — 36px tall, two stacked lines, teal hover, disabled state
- `.acct-pill-cap` — 9px uppercase gray-500 (ACCOUNT label)
- `.acct-pill-name` — 12px gray-200 (account name)
- `.acct-menu.down` — top:100%; bottom:auto; margin-top:6px (toolbar popover opens downward)
- `.acct-pill-prefix` — for ⇄ prefix on "Other logins" rows

### Batch B — AcctPill component (after A)
Add `AcctPill` function component above `MoreMenu` (~line 1407):
- Props: `{accounts, activeAcct, switchAcct, switchingAcct, vault, onManageKeys}`
- Hide guard: `return null` if `accounts.length===0 || (vault?.vaultMode && vault.locked)`
- Pill button `.acct-pill`: cap "ACCOUNT", name = active account name; disabled while switchingAcct
- Local `switchKey(id)`: `vpost('/api/vault/active',{id})` → `window.location.reload()`
- Popover `.acct-menu.down` + `.acct-overlay`:
  - **Vault mode:**
    - "This login" section label → `accounts` rows (●/○ prefix, calls `switchAcct`)
    - If `vault.tenants` has others: "Other logins" section → filtered tenants rows (⇄ prefix, calls `switchKey`)
    - Search input when total rows > 6
    - Divider + "Manage keys ›" row → calls `onManageKeys` + close
  - **Non-vault:** accounts list only, search when >6, no other sections

### Batch C — Wire into toolbar (after B)
Insert `<AcctPill .../>` immediately before `<MoreMenu .../>` at toolbar (~line 3640).
Pass: `vault`, `accounts`, `activeAcct`, `switchAcct`, `switchingAcct`.
Add `onManageKeys` handler: scrolls sidebar to bottom + sets sidebar-open state (or just `window.scrollTo(0, document.body.scrollHeight)`).

### Batch D — TDD + prove (after C)
Append tests to `test_regression.py`, hotpatch, screenshot, changelog.

## Parallelism
- Batch A: 1 agent
- Batch B: 1 agent (after A)
- Batch C: 1 agent (after B)
- Batch D: 1 agent (after C)
Max 5 cap: never exceeded (sequential chain here).

## Risk notes
- Popover must open DOWNWARD (`.acct-menu.down`) — existing `.acct-menu` opens upward (sidebar footer)
- `onManageKeys`: TenantManager owns its own open state internally; simplest approach = scroll sidebar + `TenantManager` still opens via the ⇄ button there
- `vault.locked` check: verify exact property name in vault state shape
