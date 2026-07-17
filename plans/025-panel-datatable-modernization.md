# Plan 025: Modernize shared Panel/DataTable styling toward a premier NOC aesthetic

> **Executor instructions**: Follow step by step. Run every verification command.
> This plan changes SHARED styling that affects EVERY panel and table — work
> conservatively and prove no regression at each step. If a "STOP condition"
> occurs, stop and report. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 47568d3..HEAD -- src/40.table.jsx src/60.synth-charts-panel.jsx index.html`
> On any change to these files since this plan was written, compare against the
> "Current state" notes before proceeding; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (shared styling — touches every panel/table in the app)
- **Depends on**: plans/024 (do heights first so this pass judges a stable layout)
- **Category**: tech-debt (design system)
- **Planned at**: commit `47568d3`, 2026-07-16

## Why this matters

The new tiles landed functionally correct but visually unpolished, and the fix
should raise the *shared* components rather than each tile so existing panels
benefit too. The modernization target (from a last-30-days scan of premier
observability dashboards — Grafana/Datadog/Bloomberg-grid class) is: **KPI +
sparkline lead each panel, mono numerics, muted surfaces, restrained corner
radius, uniform spacing rhythm**. Explicitly avoid the GUI-slop tells: badge/pill
rows as the only dataviz, corner radius >8px everywhere, 4-metric stat rows,
hover `scale()`. This is a taste pass with a real regression surface, so it is
P2 and gated behind the height fix (plan 024).

## Current state

No-build React 19, single global scope, no imports. Shared surfaces to touch —
and ONLY these:
- `index.html` — global CSS custom properties and base component classes. Radius
  tokens and panel classes live here (e.g. `--panel-sm/md/lg` at line 98; `.pcard`
  panel-card classes around lines 790–804).
- `src/40.table.jsx` — `DataTable` (definition ≈ line 659) and its cell/state CSS
  (`ErrorState` ≈ 1649, `IdCell` ≈ 130).
- `src/60.synth-charts-panel.jsx` — `Panel` (≈ line 780) and the `.ovx-detail`
  grid + `.pcard` styling.

Before changing any token, **find its current value and every consumer** so you
know the blast radius. Example: `grep -rn "\-\-radius\|border-radius\|--r-" index.html src/*.jsx | head -40`.

The design language is already dark-NOC with CSS variables — this is a *tightening*
pass (numerics, spacing, radius consistency), NOT a re-theme. Do not introduce new
colors, gradients, card-grid layouts, or hover-scale effects.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Type-check gate | `bash check.sh` | `✓ Type-check passed`, exit 0 |
| Build bundle | `node scripts/build_ui.js` | writes `app.bundle.js`, exit 0 |
| Full e2e gate (needs `.env`) | `bash scripts/e2e.sh` | ends with a pass summary, exit 0 |

## Scope of the taste pass (do exactly these; nothing more)

1. **Mono numerics for KPI values.** Where a tile renders a headline number
   (CTEM `total_exposures`/`asset_count`, DNS "current QPS", threat Block/Allow
   sums), ensure the number uses the existing `mono` class / `--font-mono` and a
   consistent KPI type size. If a shared KPI helper does not exist, add ONE small
   CSS class in `index.html` (e.g. `.kpi-num{font-family:var(--font-mono);font-size:…;font-variant-numeric:tabular-nums;}`)
   and apply it — do not create a React component.
2. **Restrained radius.** Audit radius tokens; ensure no surface exceeds 8px.
   Only change values that are currently >8px; leave anything ≤8px alone.
3. **Uniform spacing rhythm.** Panels should share one internal padding/gap scale.
   If tiles use ad-hoc inline `padding`/`gap`, align them to the existing spacing
   vars (`--s2/--s3/…`) used by the exemplar panels. Prefer editing the shared
   `.pcard`/`Panel` styling over per-tile inline styles.
4. **Sparkline prominence.** Where a KPI has a trend (DNS QPS, CTEM hourly), the
   sparkline should sit directly under the number at a consistent height. Use the
   existing `Sparkline` component; do not restyle it globally beyond a shared
   height.

Do NOT: add gradients, add a card-grid, change the color palette, add hover
`scale()` transitions, add badge/pill rows as a panel's only content, or round
corners past 8px.

## Steps

### Step 1 — Inventory before editing

```
grep -rnE "border-radius|--r-|--radius" index.html | sort -u
grep -rnE "\.kpi|font-variant-numeric|tabular-nums|--font-mono" index.html src/*.jsx
```
Record which radius tokens exceed 8px and whether a KPI/mono numeric class
already exists. Only tokens >8px are in scope for step 3.

### Step 2 — Add/confirm a shared KPI numeric class (index.html)

If no tabular-mono KPI class exists, add one class to the CSS in `index.html` and
apply it to the headline numbers in the CSP tiles (`src/70/74/76/78/80.tab.*.jsx`)
— replacing ad-hoc inline number styling. One class, applied consistently.

### Step 3 — Clamp radius >8px (index.html only)

For each radius token/value found >8px in step 1, reduce to ≤8px. Change nothing
that is already ≤8px. This is a token edit, not a structural change.

### Step 4 — Align panel padding/gap to the shared scale

Where the CSP tiles use ad-hoc inline `padding`/`gap`, replace with the spacing
vars used by exemplar panels (look at how `OnPremHostsPanel` / an existing
non-CSP panel is spaced). Prefer moving shared spacing into `.pcard`/`Panel`
styling in `src/60.synth-charts-panel.jsx` so all panels inherit it.

### Step 5 — Build, type-check, and prove no regression

```
node scripts/build_ui.js
bash check.sh
```
Both exit 0. Then, if `.env` with `INFOBLOX_API_KEY` is present, run the full
gate:
```
bash scripts/e2e.sh
```
It must end with a passing summary (the `layout-overflow` spec especially must
stay green — shared-CSS edits are exactly what can trip it).

## Done criteria (machine-checkable)

- `bash check.sh` exits 0.
- `node scripts/build_ui.js` exits 0.
- `grep -rnE "border-radius:\s*(9|[1-9][0-9])px|--r-[a-z]+:\s*(9|[1-9][0-9])px" index.html`
  returns nothing (no radius token >8px remains).
- A single shared KPI numeric class exists in `index.html` and is referenced by
  the CSP tile files: `grep -rl "kpi-num" src/*.tab.*.jsx` lists at least the
  security + dns tiles.
- If `scripts/e2e.sh` was runnable: it exits 0 and reports no new
  `layout-overflow` failures.

## Test plan

No new automated test is required; the existing `tests/theme.spec.ts`,
`tests/cell-legibility.spec.ts`, and `tests/layout-overflow.spec.ts` are the
guardrails for shared-styling changes. Run them via `scripts/e2e.sh` and confirm
they stay green. If any of those three regress, the taste pass overreached — see
STOP conditions.

## STOP conditions

- If clamping a radius token or changing shared spacing causes
  `tests/theme.spec.ts` / `tests/cell-legibility.spec.ts` /
  `tests/layout-overflow.spec.ts` to fail — STOP and report which token; revert
  that single change rather than compensating elsewhere.
- If you find yourself changing colors, adding gradients, or restructuring a
  panel's layout to "make it look better" — STOP; that is out of scope for this
  pass.
- If a "shared" edit would change a non-CSP panel in a way you cannot verify is
  intended — STOP and report; this pass must not silently restyle unrelated tabs.

## Maintenance note

This plan intentionally raises the shared components so future tiles inherit the
polished defaults. Reviewers of later work should push new tiles to use the KPI
class and shared spacing rather than inline styles, and reject radius >8px.

## Out of scope (do not touch)

- `server.py`, any `/api/*` endpoint, data shaping.
- `src/96.chrome-topbar.jsx` (plan 023) and the per-tile height props (plan 024).
- Color palette, theme tokens' hues, gradients, animations.
- Any tab logic or component behavior — this is styling only.
