# Design / GUI Change Workflow

Applies to **any** change that alters the visual UI or its behavior (layout, components,
colors, charts, menus, copy in the interface). Not required for pure backend/logic changes.

## Rule: mockup first, then launch in the browser

1. **Always produce a mockup before (or alongside) implementing** a design/GUI change.
   - Build a standalone mockup using the app's **real design tokens** (copy the relevant
     `:root` variables and component CSS from `index.html` so it looks identical).
   - Show multiple states/variants when the choice isn't obvious.
2. **Always launch it in the browser** so it can be reviewed visually:
   - Screenshot headless for the conversation:
     `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --window-size=W,H --screenshot=out.png "file://$PWD/_mockup.html"`
   - And open it for live viewing: `open _mockup.html`
   - (Headless renders the LIGHT theme by default — verify dark by construction; see the
     `verify-ui-headless-chrome` note.)
3. **You have full autonomy** over how mockups are structured (single page with side-by-side
   variants, multiple files, states A/B/C, etc.). Pick whatever communicates the choice best.
4. Clean up scratch mockup files (`_mockup*.html/.png`) once the direction is locked.

## Variation dimensions (pick 4–6 per campaign)

- **Layout** — sidebar position, card vs table, grid vs list
- **Density** — compact (operator) vs spacious (executive)
- **Hierarchy** — visual weight of severity vs entity vs count
- **Color use** — severity-only vs accent-highlighted CTA
- **Borders** — none vs subtle (current) vs strong
- **Motion** — static vs live-pulse vs loading states
- **Copy** — verbose labels vs short labels vs icon-only

## Required output format

Every time a mockup is created or updated, output this table:

```
| File | How to view |
|---|---|
| `_mockup-<slug>.html` | `open _mockup-<slug>.html` |
| Screenshot | `--screenshot=_mockup-<slug>.png "file://$PWD/_mockup-<slug>.html"` |
```

## After direction is locked

1. Delete or archive the mockup file.
2. Write production code matching chosen variation exactly.
3. Hotpatch + screenshot to verify (per `docs/TESTING.md`).

## Why
The dashboard is a single-file React app served from a Docker image; visual changes are
easy to get subtly wrong and slow to redeploy. A mockup + browser check catches layout,
contrast, and density problems before a full build/CI/deploy cycle.
