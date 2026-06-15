# Grill-me: multi-tenant-switcher — 2026-06-15

## Decisions

| Q | Decision |
|---|---------|
| What's missing vs existing TenantManager sidebar? | A — surface active account as persistent toolbar pill (always visible for NOC wall display) |
| Pill placement in toolbar | A — right side, just left of ⋯ menu; "key › account" format when key label differs from account name |
| Click behavior | A — compact inline popover anchored to pill: account list + "Manage keys ›" link to sidebar (vault mode); account list only (non-vault) |
| Vault-locked / no accounts state | A — hide pill entirely |
| Non-vault mode (env key) | A — show pill + popover; no "Manage keys ›" link |

## What changes

### `index.html` only

1. **Toolbar pill** — new `AccountPill` component rendered in toolbar right side, left of `MoreMenu` button.
   - Hidden when: no accounts loaded, OR vault mode + vault locked
   - Shows: active account name (truncated ~20ch). When `keyDiffers` (key label ≠ account name): "key › account"
   - On click: opens `AccountPopover` anchored to pill

2. **AccountPopover** — compact dropdown anchored to pill
   - Account list (same `acct-menu-item` style as sidebar, scrollable if >6)
   - Search input if accounts > 6
   - Divider + "Manage keys ›" row (vault mode only) → scrolls sidebar to bottom + opens TenantManager
   - Click outside closes

3. **CSS** — `.acct-pill`, `.acct-pill:hover`, `.acct-pill.switching` styles (reuse existing `.acct-menu`, `.acct-menu-item` for popover)

4. **State wiring** — `AccountPill` receives: `accounts`, `activeAcct`, `switchAcct`, `switchingAcct`, `vault` (for vault mode detection). These props already exist at the root render site.

## Updated: Popover structure (Q6+Q7)

Popover has TWO sections:

**"This login"** — CSP sub-accounts of the current active vault key. Always selectable. Clicking → `switchAcct(id)` (no reload, just account switch). Leading icon: `●` active / `○` inactive.

**"Other logins"** — other stored vault keys (from `vault.tenants` where `t.id !== vault.active`). Clicking → `switchKey(id)` (triggers reload). Leading icon: `⇄` or key glyph to distinguish from account rows. Non-vault mode: this section hidden entirely.

**Separator** between sections: `.acct-sec-divider` + `.acct-sec-label` ("Other logins").

**Add-key path**: "Manage keys ›" row only (no inline "+ Add login" in pill popover).

**Single-account, single-key case**: no section headers needed — just the one account + Manage keys link.

## Open flags
None.

## Q&A log
Q1: What's missing vs existing TenantManager? → A (toolbar pill for visibility)
Q2: Pill placement? → A (right side, left of ⋯, key›account format)
Q3: Click behavior? → A (compact inline popover, two-section: This login + Other logins)
Q4: Vault locked / no accounts? → A (hide pill)
Q5: Non-vault mode? → A (show pill, no Manage keys / Other logins sections)
Q6: Visually separate accounts by key? → A (two sections: "This login" / "Other logins"; clicking other key triggers key switch)
Q7: Inline "+ Add login" in pill popover? → A (no — Manage keys › only)
