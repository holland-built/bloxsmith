# Design Audit — Infoblox NOC Dashboard Bento Cards
**Date:** 2026-06-28  
**Scope:** Bento cards (DHCP Pools, Host Status, IPAM Subnets, DNS Zones, Active Threats, Audit Events) — topbar/navbar excluded (just redesigned)  
**Lenses:** Taste, Swiss, UIwiki, Accessibility (WCAG 2.1 AA), CSS Code Health

---

## Violations Table

| # | Lens | Finding | Severity | Mode | File:line |
|---|---|---|---|---|---|
| 1 | Swiss + Taste | Border radius 6px violates locked 2px token (`--radius:2px`) — all cards | CRITICAL | both | index.html:206 |
| 2 | UIwiki | `.wall-span-btn` touch targets ~16px (should be ≥44px) | CRITICAL | both | index.html:749 |
| 3 | A11y | Muted text #75767b on #24252a = 3.14:1 — fails WCAG AA 4.5:1 | CRITICAL | dark | index.html:439 |
| 4 | CSS + Taste | Card hover border-color hardcoded `rgba(61,186,95,.4)` (green) — should be `var(--teal)` | HIGH | both | index.html:207 |
| 5 | UIwiki + A11y | No keyboard support for drag-reorder or height/width resize (mouse-only) | HIGH | both | index.html:4851–4854 |
| 6 | A11y | No `:focus-visible` on `.col-btn` (CSV) or `.wall-span-btn` (resize) | HIGH | both | index.html:624, 749 |
| 7 | A11y | CSV + resize buttons missing `aria-label` (only `title` attribute) | HIGH | both | index.html:5733, 4853 |
| 8 | CSS | `.card` selector defined twice (line 206 + 234); `.tbl` defined twice (241 + 253) | HIGH | both | index.html:206, 234, 241, 253 |
| 9 | Taste + Swiss | All 6 cards same min-width/column span — no visual hierarchy by card importance | HIGH | both | index.html:219 |
| 10 | Swiss | 5 type sizes in use per card (10/11/12/13/28px) — Swiss max is 3 | HIGH | both | index.html:220–223 |
| 11 | Taste | DHCP Pools: red bars only, no %, no legend, no severity icon | MEDIUM | both | index.html:~300 |
| 12 | UIwiki | Drag handle `⠿` not recognizable; no `cursor:grab` feedback | MEDIUM | both | index.html:4851 |
| 13 | UIwiki | No per-card loading state during refresh — only global `refreshing` flag | MEDIUM | both | index.html:5722 |
| 14 | Swiss | Decorative `::after` separator line on card title — no data purpose | MEDIUM | both | index.html:251 |
| 15 | Swiss | Hover stacks 3 shadows — kills data-ink ratio | MEDIUM | both | index.html:207 |
| 16 | A11y | Color-only status in Active Threats hits column (no icon/label) | MEDIUM | both | index.html:5876 |
| 17 | A11y | Cards lack `role="region"` / `aria-labelledby` — no landmark nav | MEDIUM | both | index.html:5922 |
| 18 | CSS | Magic numbers: `gap:7px` (card-title), `padding:7px` (tbl th), `gap:11px` (compact) — off token scale | MEDIUM | both | index.html:213, 242, 739 |
| 19 | Taste | Table hover color-only — no left border or stripe | LOW | both | index.html:244 |
| 20 | UIwiki | Empty state only in Active Threats card — other 5 cards have no empty state | LOW | both | index.html:5884 |

---

## Top 10 Improvements

| # | Improvement | Why it matters | Effort | Lens |
|---|---|---|---|---|
| 1 | Fix border-radius: 6px → 2px on `.card` | Violates locked design token; inconsistent with rest of UI | S | Swiss/Taste |
| 2 | Replace hover `rgba(61,186,95,.4)` with `var(--teal)` | Wrong semantic color — green = success, not hover accent | S | CSS/Taste |
| 3 | Increase muted text contrast: `--muted` → `--gray-200` on card titles | 3.14:1 fails WCAG AA — NOC operators need legibility at a glance | S | A11y |
| 4 | Add `:focus-visible` to `.col-btn` and `.wall-span-btn` | Keyboard users cannot navigate card controls | S | A11y |
| 5 | Add `aria-label` to CSV + resize/width buttons | Screen readers cannot describe card controls | S | A11y |
| 6 | Merge duplicate `.card` + `.tbl` CSS selectors | Duplicate rules cause maintainability issues + specificity bugs | S | CSS |
| 7 | Fix magic numbers 7px→8px (gap, padding) + 11px→12px (compact) | Breaks token scale; inconsistent spacing | S | CSS |
| 8 | Make drag handle recognizable: `cursor:grab`, `title="Drag to reorder"`, standard icon | ⠿ is not discoverable as drag affordance | M | UIwiki |
| 9 | Add DHCP bar context: utilization % label + threshold marker | Bars alone have no scale — is 95% bad? How bad? | M | Taste |
| 10 | Add `role="region"` + `aria-labelledby` to each bento card | Landmark navigation missing for screen reader users | M | A11y |

---

## Locked tokens (for /design-fix or /build)
```
--radius: 2px
--teal (dark): #6694ff
--teal (light): #003ecc
--ink (dark): #e8e8ea
--muted (dark): #75767b  -- contrast fails on surface; upgrade to --gray-200 for titles
--surface (dark): #24252a
Font: Inter + Geist Mono
```
