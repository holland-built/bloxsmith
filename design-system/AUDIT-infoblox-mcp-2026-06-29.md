# Design Audit — Infoblox NOC Dashboard
**Date:** 2026-06-29
**Scope:** All bento cards + topbar
**Palette:** v4 — warm charcoal dark / parchment light / terracotta accent
**Prior audit:** AUDIT-infoblox-mcp-2026-06-28.md (old New Relic blue theme)

---

## Finding Status vs Prior Audit

| # | Prior Finding | Status | Evidence |
|---|---|---|---|
| 1 | Card border-radius 6px vs 2px token | **FIXED** | `.card` uses `var(--radius)`=3px (line 206) |
| 2 | wall-span-btn touch target ~16px | **FIXED** | `min-height:44px;min-width:44px` (line 749) |
| 3 | Muted text contrast CRITICAL dark | **FIXED** | `--muted:#848783` on `#161a18` ≈ 4.8:1 PASS |
| 4 | Card hover hardcoded green | **FIXED** | Now `border-color:var(--teal)` (line 207) |
| 5 | No keyboard drag-reorder | **PARTIAL** | Arrow keys cycle span/height; card drag still mouse-only |
| 6 | No `:focus-visible` on col-btn/wall-span-btn | **FIXED** | Both have rules (lines 623, 751) |
| 7 | aria-label missing on CSV/resize | **FIXED** | All labeled (lines 4856–4857, 1609) |
| 8 | Duplicate `.card` + `.tbl` selectors | **FIXED** | One of each (lines 206, 240) |
| 9 | No visual hierarchy by card importance | **OPEN** | Default spans identical across all 6 cards |
| 10 | 5 type sizes per card | **OPEN** | 10/11/12/13/28px still in use |
| 11 | DHCP bars: no %, no threshold markers | **PARTIAL** | `{s.util}%` label present; threshold lines (75%/90%) absent |
| 12 | Drag handle not recognizable | **FIXED** | `cursor:grab`, `aria-label`, `title` (lines 539–541, 4854) |
| 13 | No per-card loading state | **OPEN** | Global refreshing flag only |
| 14 | Decorative `::after` separator on card title | **OPEN** | Still at line 250 |
| 15 | Hover stacks 3 shadows | **FIXED** | Single `box-shadow` on hover (line 207) |
| 16 | Color-only status in Active Threats hits col | **OPEN** | Badges have bg+color+border but icon still absent |
| 17 | Cards lack `role="region"` / `aria-labelledby` | **FIXED** | Present at line 5935 |
| 18 | Magic numbers 7px/11px | **FIXED** | Corrected to 8px/12px |
| 19 | Table hover color-only | **FIXED** | Now background + left border teal (line 243) |
| 20 | Empty states only in Active Threats | **PARTIAL** | `.no-data` class used broadly; styling inconsistent |

Fixed: **12** / Partial: **3** / Open: **5**

---

## Open + New Violations

| # | Lens | Finding | Severity | Mode | File:line |
|---|---|---|---|---|---|
| 1 | UIwiki + A11y | Card drag-reorder still mouse-only; keyboard users can't reorder cards | HIGH | both | index.html:4854 |
| 2 | Taste + Swiss | All 6 bento cards same default column span — no importance hierarchy | HIGH | both | index.html:219 |
| 3 | Swiss | 5 type sizes per card (10/11/12/13/28px) — Swiss max is 3 | HIGH | both | index.html:220–223 |
| 4 | Taste | DHCP utilization bars missing 75%/90% threshold marker lines | MEDIUM | both | index.html:~3575 |
| 5 | UIwiki | No per-card loading state during refresh — global flag only | MEDIUM | both | index.html:5722 |
| 6 | Swiss | Decorative `::after` separator under card title — no data purpose | MEDIUM | both | index.html:250 |
| 7 | A11y | Active Threats hits column: color-only severity (no icon/text label) | MEDIUM | both | index.html:5876 |
| 8 | UIwiki | Empty states inconsistent: cards show plain "No data", not structured `.no-data` | LOW | both | index.html:2004 |
| 9 | CSS | `border-radius:6px/7px` hardcoded on ~12 non-card elements (alerts, buttons, tooltips) — violates `--radius:3px` token | MEDIUM | both | index.html:170,184,280,347,349 |
| 10 | CSS | `section-badge` colors use literal `rgba(63,185,80,...)` etc instead of `var(--green)`/`var(--amber)`/`var(--red)` | LOW | both | index.html:429–431 |
| 11 | CSS | `--teal` var name retained; accent is terracotta (`#e86340`) — semantic mismatch makes CSS hard to read | LOW | both | index.html:37 |

---

## Top 10 Improvements (actionable, ordered by impact)

| # | Improvement | Why | Effort | Lens |
|---|---|---|---|---|
| 1 | Add keyboard reorder for bento cards (Tab focus handle + arrow keys move) | Only mouse works — screen reader + keyboard users can't reorder | M | A11y/UIwiki |
| 2 | Add 75%/90% threshold marker lines to DHCP utilization bars | Bars without scale reference are uninterpretable at a glance | M | Taste |
| 3 | Add per-card loading skeletons (replace global refreshing only) | Users can't tell which card is stale vs loaded | M | UIwiki |
| 4 | Normalize non-card `border-radius` to `var(--radius)` (6px→3px on alerts/tooltips/buttons) | ~12 hardcoded 6–7px radii break token contract | S | CSS |
| 5 | Add severity icon to Active Threats hits column alongside color | Color alone fails color-blind users | S | A11y |
| 6 | Replace `.section-badge` literal `rgba(...)` with `var(--red)`/`var(--amber)`/`var(--green)` | Stale values won't track token changes | S | CSS |
| 7 | Set default card spans by importance (e.g. Active Threats = 2-col, DNS Zones = 1-col) | All same width reduces scanning efficiency | S | Taste/Swiss |
| 8 | Remove decorative `::after` separator from card title | Adds visual noise; border is already on the card | S | Swiss |
| 9 | Standardize empty state: use `.no-data` class everywhere with consistent icon + message | "No data" text alone is too sparse | S | UIwiki |
| 10 | Rename `--teal` → `--accent` in CSS | Prevents future confusion when adding teal-colored elements | S | CSS |

---

## Token Reference (v4 — current)
```
Dark:   bg #0d0f0e  surface #161a18  accent(--teal) #e86340  ink #f0f0ec  muted #848783
Light:  bg #f5f2ed  surface #ede9e3  accent(--teal) #b54218  ink #1a1814  muted #5e5c57
Radius: 3px (var(--radius))
Fonts:  DM Sans (UI) + JetBrains Mono (data)
```
