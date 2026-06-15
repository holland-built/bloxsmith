---
name: layout-stress
description: "Use to find and fix LAYOUT-COMPOSITION bugs — the class that only breaks at runtime when panels combine or the viewport narrows: sidebar OVERLAPPING content, bento cards CLIPPED at an edge, text TRUNCATING when it would fit, fixed panels causing HORIZONTAL OVERFLOW, z-index/stacking errors (sidebar over drill panel, UpdateBar under nav). Trigger when the user reports: 'sidebars overlapping', 'cut off', 'clipped', 'text truncated', 'horizontal scrollbar', 'broken at this width', or shares screenshots of overlapping/clipped UI. Not for color/typography nits (use impeccable) — for spatial/layout robustness only."
argument-hint: "[screen or 'all']"
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
---

# layout-stress — panel-composition layout robustness

## What this fixes (the CLASS, never just the example)

| Symptom | Typical root cause |
|---|---|
| Sidebar **overlaps** content | wrong `position` context, missing `margin-left` on `.main` |
| Content **clipped** at edge | parent `overflow:hidden` clipping child; fixed-px child too wide |
| Cards **bleed under** fixed UpdateBar | `position:fixed` bar with no matching `padding-top` on scroll container |
| Text **truncates** when it would fit | flex child without `min-width:0` forcing premature ellipsis |
| Horizontal scrollbar | unbounded child, `width:100vw` inside padded container |
| z-index collision | UpdateBar z-index < sidebar; drill panel behind nav |

## Why static audits miss it

`impeccable` reads code + default-state single-panel screenshots. These bugs need (a) combinatorial panel states, (b) runtime overflow measurement, (c) multiple viewport widths.

## Panel states to test

The dashboard has three main state dimensions:

| Dimension | States |
|---|---|
| **Sidebar** | expanded (224px) ↔ collapsed |
| **Chat panel** | closed ↔ open (340px right) |
| **Drill-down** | none ↔ open inside a card |
| **UpdateBar** | hidden ↔ visible (amber fixed bar at top) |

**High-yield combos**: sidebar expanded + chat open at narrow widths (1024px, 1280px).

## Method — headless Chrome at multiple widths

```bash
for W in 1024 1280 1440 1680; do
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless --disable-gpu --window-size=${W},900 \
    --screenshot=_layout_${W}.png "http://localhost:8080"
done
```

Read each screenshot. Check for:
1. **Overflow**: any content extending past the right viewport edge?
2. **Overlap**: sidebar rail overlapping `.main` content area?
3. **Bleed**: cards hidden under fixed bars (UpdateBar, topbar)?
4. **Truncation**: text cut off at a width where it should fit?

## Fix root causes, not per-component patches

- **`min-width:0` on flex children** — flex items default to `min-width:auto` and refuse to shrink
- **Reserve panel space** — `.main` must account for sidebar width via `margin-left` or grid track
- **z-index scale** — UpdateBar `z-index:9999` > sidebar > nav > content; no ad-hoc values
- **Overflow boundaries** — scroll containers own `overflow-y:auto`; never `overflow:hidden` on a parent that clips needed content
- **No fixed px widths** that can't reflow; use `min()`/`max()`/`calc(100% - Xpx)`

Honor the CSS tokens in `index.html` — no raw hex colors in layout fixes.

## Evidence gate

- Screenshots at all 4 widths: zero overflow, zero overlap, zero premature truncation
- `python -m pytest test_regression.py -v` green
- Clean up `_layout_*.png` after reporting

## Output

Bullet/table summary: bug classes found, widths affected, root-cause fixes applied.
