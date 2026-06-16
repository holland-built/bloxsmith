# Grill-me: consolidate-account-key-ui — 2026-06-16

## Decisions

| # | Question | Answer | Notes |
|---|---|---|---|
| 1 | AcctPill fate | A — remove from topbar entirely | Sidebar becomes single surface |
| 2 | Panel presentation | A — click-to-expand dropdown (keep current TenantManager pattern) | Sidebar real estate preserved |
| 3 | Panel contents layout | A — sub-views (account list at top merged from AcctPill; Keys › drills into CRUD sub-view) | Progressive disclosure |
| 4 | Collapsed trigger | A — show active account name: `● Acme Corp  ⇄` | Only visible place active account shows once AcctPill removed |

## Open flags
- None — all branches resolved.

## Q&A log

**Q1:** Remove AcctPill from topbar or keep as compact chip?
**A:** A — remove entirely. Sidebar is single surface for tenant/key management. Topbar = operational only (refresh, query).

**Q2:** Always-visible inline vs click-to-expand vs compact footer strip?
**A:** A — click-to-expand (like current TenantManager ⇄). Sidebar space is precious.

**Q3:** Sub-views vs flat vs tabs for expanded panel?
**A:** A — sub-views. Main view: account list (from AcctPill) at top + Keys/Test/Lock/AI below. Keys › drills to CRUD sub-view. Test connection stays in main view.

**Q4:** Collapsed trigger appearance?
**A:** A — show active account name: `● Acme Corp  ⇄`. Active context always visible without opening.

## Implementation summary

1. **Remove AcctPill** from topbar (line ~3706 in index.html). Remove its props from App render.
2. **Expand TenantManager** collapsed trigger to show active account name (`● {headline}  ⇄`).
3. **Merge account list** from AcctPill into TenantManager expanded main view — at top, above Manage section. Same visual style (teal left-border = has key, gray = no key, ● active, ○ inactive). Switching account or tenant key from here.
4. **Wire + Add key** affordance for no-key accounts (was in AcctPill, now in TenantManager account list).
5. **onManageKeys** callback no longer needed — remove the prop / no-op.
6. Test connection, Lock vault, AI provider stay in main view. Keys › sub-view unchanged.
7. Update regression tests: remove AcctPill topbar tests, add TenantManager account-list tests.
