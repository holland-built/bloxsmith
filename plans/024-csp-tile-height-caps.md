# Plan 024: Every CSP tile has a uniform max height (no more variable-tall panels)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. If a "STOP condition" occurs,
> stop and report. When done, update this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 47568d3..HEAD -- src/70.tab.overview.jsx src/74.tab.network.jsx src/76.tab.dns.jsx src/78.tab.infra.jsx src/80.tab.security.jsx`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (layout) / tech-debt
- **Planned at**: commit `47568d3`, 2026-07-16

## Why this matters

15 CSP data tiles were recently added across five tabs. Most table-based tiles
cap their body height with the `DataTable` `scrollBody={N}` prop (so a 500-row
table scrolls inside a fixed box), but several tiles were left **uncapped** and
grow as tall as their data — a 500-row host table or a long chip cloud pushes the
whole page down and breaks the scannable grid. The premier-monitoring convention
(and the rest of this dashboard) is a **fixed tile height with internal scroll**.
This plan makes every new tile obey one consistent height budget so the tabs read
as a uniform grid instead of a ragged column.

## Current state

No-build React 19: `src/*.jsx` concatenated by `scripts/build_ui.js` into
`app.bundle.js`, single global scope, **no imports/exports**. Shared components:
`DataTable` (`src/40.table.jsx`), `Panel` (`src/60.synth-charts-panel.jsx`),
`Sparkline` (`src/20.lib-data-power.jsx`). Every tile follows the error/empty/ok
trichotomy: `feed.error||status==='error'` → `<ErrorState/>`; empty → muted "no
data" copy; else content. **That trichotomy must be preserved on every tile.**

**Height tokens already defined** in `index.html:98`:
```
--panel-sm:220px; --panel-md:340px; --panel-lg:560px;
```

**The `DataTable` height cap is the `scrollBody` prop** — a number (px) makes the
table body a fixed-height internal scroller. Exemplar (already correct),
`src/78.tab.infra.jsx` `OnPremHostsPanel`:
```jsx
<DataTable cols={cols} rows={rows} rowKey={r=>String(r.ophid||r.name)}
  tableId="csp-onprem-hosts" csvName="csp-onprem-hosts" scrollBody={480} filterable/>
```

**The uncapped / inconsistent tiles to fix:**

1. `src/78.tab.infra.jsx` — `HostHealthPanel` (≈line 306): `DataTable` has **no
   `scrollBody`** → 500 rows render full-height.
   ```jsx
   : <DataTable cols={cols} rows={rows} rowKey={r=>String(r.name)}
       tableId="csp-host-health" csvName="csp-host-health" filterable/>
   ```
2. `src/78.tab.infra.jsx` — `JobsPanel` (≈line 339): `DataTable` has **no
   `scrollBody`**.
   ```jsx
   : <DataTable cols={cols} rows={rows} rowKey={r=>String(r.id||r.created_at)}
       tableId="csp-jobs" csvName="csp-jobs" defaultSort={{key:'created_at',dir:'desc'}}/>
   ```
3. `src/80.tab.security.jsx` — the non-table KPI/chip/matrix panels
   `ThreatRibbonPanel` (≈566), `CtemExposurePanel` (≈589), `CtemAssetsPanel`
   (≈615), `SocInsightsPanel` (≈646). These render KPI numbers + a sparkline +
   a chip cloud / matrix table with **no height bound**, so the CTEM chip cloud
   and the severity/priority matrix can run long.

Everything else (OnPrem, DFP, DnsServices, ZoneInventory, DnsQps, IpamUtil,
DhcpLeases, LicenseAlerts) already sets `scrollBody` — leave those as-is.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Type-check gate | `bash check.sh` | `✓ Type-check passed`, exit 0 |
| Build bundle | `node scripts/build_ui.js` | writes `app.bundle.js`, exit 0 |

## The one height standard to apply

- **Table tiles** (a `DataTable` is the tile body): add `scrollBody={480}` if
  missing. `480` is the value the sibling table tiles already use — match it
  exactly so all table tiles are the same height.
- **Non-table tiles** (KPI / sparkline / chip cloud / matrix): wrap the scrolling
  content region in a fixed-height scroller:
  `style={{maxHeight:'var(--panel-md)',overflow:'auto'}}` on the container that
  holds the variable-length part (the chip cloud, the matrix). Keep the KPI/
  sparkline header **outside** the scroller so the headline number stays pinned.

Do not invent new pixel values — use `scrollBody={480}` for tables and the
`--panel-md` token for non-table scrollers.

## Steps

### Step 1 — Cap the two uncapped infra tables

In `src/78.tab.infra.jsx`:
- `HostHealthPanel`: add `scrollBody={480}` to its `DataTable` (keep `filterable`
  and all other props).
- `JobsPanel`: add `scrollBody={480}` to its `DataTable` (keep `defaultSort` and
  all other props).

Verify: `grep -c "scrollBody={480}" src/78.tab.infra.jsx` returns at least `4`
(HostHealth, OnPrem, Dfp, Jobs — plus any pre-existing infra table).

### Step 2 — Bound the security KPI/chip/matrix panels

In `src/80.tab.security.jsx`, for each of `ThreatRibbonPanel`,
`CtemExposurePanel`, `CtemAssetsPanel`, `SocInsightsPanel`:
- If the panel body is a `DataTable` (e.g. the CTEM matrix table, SOC types
  table, threat table), give that `DataTable` `scrollBody={480}`.
- If the panel body is a chip cloud or free-form KPI block (CTEM assets
  providers/technologies/ports chips), wrap the chip region in a
  `<div style={{maxHeight:'var(--panel-md)',overflow:'auto'}}>…</div>`, leaving
  the `asset_count` KPI above it unscrolled.
- Preserve the error/empty/ok branches exactly — only the *content* branch gets
  the height bound; `ErrorState` and the empty-copy branch are untouched.

Verify the trichotomy survived: `grep -c "ErrorState" src/80.tab.security.jsx`
returns the same count as before your edit (record it first with the same grep).

### Step 3 — Build + type-check

```
node scripts/build_ui.js
bash check.sh
```
Both exit 0.

## Done criteria (machine-checkable)

- `bash check.sh` exits 0 (`✓ Type-check passed`).
- `node scripts/build_ui.js` exits 0.
- `grep -c "scrollBody={480}" src/78.tab.infra.jsx` ≥ `4`.
- In `src/80.tab.security.jsx`, each of the four panel functions
  (`ThreatRibbonPanel`, `CtemExposurePanel`, `CtemAssetsPanel`,
  `SocInsightsPanel`) contains either a `scrollBody={480}` or a
  `maxHeight:'var(--panel-md)'` inside its content branch. Verify by reading each
  function.
- `ErrorState` occurrence count in both edited files is unchanged from before the
  edit (trichotomy preserved).

## Anti-regression: the layout-overflow gate

This repo's e2e suite includes `tests/layout-overflow.spec.ts`, which fails the
build if any element's `scrollWidth > clientWidth` at 1440/1400/375 widths (a
prior CSP tile tripped it). After building, if the reviewer runs the e2e gate
(`scripts/e2e.sh`, needs `.env`), the overview/security/infra/dns/network tabs
must show **no** new overflow offenders. Do not introduce fixed pixel *widths*;
only bound heights.

## STOP conditions

- If a targeted panel no longer exists or its body is already height-bounded
  (drift) — skip it and note it; do not force a redundant wrapper.
- If adding `scrollBody={480}` to `HostHealthPanel`/`JobsPanel` makes
  `check.sh` fail — STOP and report the error (do not remove other props to
  "make room").

## Maintenance note

Every future data tile must set a height budget: `scrollBody={480}` for tables,
`maxHeight:var(--panel-md/lg)` for non-table bodies. A tile with no height bound
is the defect this plan fixes — reviewers should reject one.

## Out of scope (do not touch)

- `server.py`, any `/api/csp/*` endpoint, data shaping, the error/empty copy.
- The tiles that already set `scrollBody` (do not change their values).
- `src/96.chrome-topbar.jsx` (that's plan 023).
- Visual restyling beyond the height bound — that is plan 025.
