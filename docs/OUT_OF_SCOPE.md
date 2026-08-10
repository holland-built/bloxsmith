# Out of Scope — NOC Dashboard Rewrite (v1)

> This list is a committed decision, not a placeholder — revisiting any item requires a new planning pass, not an ad-hoc feature request.
>
> One thing you may do without a planning pass: append a dated note to an item saying where the line actually falls, once something shipped near it. A clarification only adds words — it may never narrow a ban, and it may never stand in for the planning pass a real reversal needs.

1. **AI-driven anomaly-detection badges** — Black-box confidence scores erode operator trust during incidents; a transparent, tunable threshold beats an unexplainable "AI insight."

2. **On-prem air-gapped install** — High support-cost sink for a solo-maintained product; gate behind a future paid tier only if a signed deal demands it.

3. **Social/collaboration features** — Never move a deal or reduce time-to-resolution in this product category; pure scope creep.

4. **Drag-drop dashboard builder / plugin marketplace** — Nobody using this dashboard can make a new panel, point a panel at a data source of their choosing, pick what kind of chart it draws, or install someone else's code into it, and none of those are planned. The exact kind of "best of everything" ambition that causes a small team to never ship; a typed panel contract with a fixed set of verticals ships faster and stays maintainable.

   *Clarified 2026-08-09.* Releases v3.59.0 (8 August 2026) through v3.61.1 (9 August 2026) shipped panel **arranging** on every tab: drag a panel by its ⠿ grip to reorder it, drag its right edge to change its width, press ✕ to take it off the page, and use the "Arrange panels" button to reorder or put panels back. That is the second half of this item — the fixed set of panels, moved around — not the first. The panels themselves are still written into the app and shipped with it. What each tab remembers is capped at three things: the order, the widths, and which panels are off the page (plus the saved record's own name and format number). A check called `validateSave` in `ui/src/lib/layout.js` refuses to send anything beyond that, so the feature has no room to grow quietly into the builder banned above. The reasoning is in [ADR 0001](adr/0001-layout-persists-order-and-span-only.md).

5. **Configurable 40-chart-type library** — 4-5 chart types (line, area, heatmap, single-stat, table) cover the real verticals; more choice adds surface area without adding signal.
