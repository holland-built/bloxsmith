import { test, expect } from './fixtures';

// WHAT THIS FILE IS, AND WHAT IT IS NOT.
//
// A committed, human-reviewable record of the STRUCTURE of each page's body —
// its headings, panel names, table column headers, buttons and copy — captured
// as an accessibility-tree snapshot under page-baseline.spec.ts-snapshots/.
// A rename, a deletion, or a reordering of any of those shows up on the next
// run as an ordinary git diff that a person reads and approves.
//
// It exists because nothing else here proved page CONTENT. tests/tabs-smoke.spec.ts
// visits all 15 tabs and asserts an h1 is visible with no console errors, which
// is "the tab did not blow up" — a tab that quietly loses a whole panel passes
// it. That matters now: 89eb6dc made every tab a separately-fetched chunk and
// every tab carries a layoutKey whose mis-wiring is reported by console.error
// rather than by anything visible.
//
// THREE LIMITS, stated here because a green check that is trusted for more than
// it proves is worse than no check.
//
//  1. NO DATA IS PROVEN. These snapshots are captured with no Infoblox tenant
//     (scripts/e2e.sh blanks every credential), so the panels below the headings
//     hold whatever this app shows when a feed is unavailable. This file proves
//     the page's skeleton is unchanged. It says NOTHING about whether the right
//     numbers, rows or series render. That is the tier-2 job in
//     plans/033-page-baselines.md: fake every /api/ response with fixed
//     synthetic data so a populated page can be baselined too.
//  2. NO CHARTS ARE PROVEN. An accessibility tree does not contain the interior
//     of an SVG. recharts output is invisible to this file beyond whatever
//     accessible name its container carries.
//  3. NUMBERS INSIDE LABELS ARE NOT PINNED. Playwright's generator rewrites any
//     accessible name containing digits into a regex — "DNS Query Rate — 24h"
//     is stored as /DNS Query Rate — \d+[hmsp]+/, so changing that window to 1h
//     would NOT fail. Deliberately left alone: hand-editing those back to
//     literals works until the next --update-snapshots quietly regenerates them.
//     Panel names, controls and copy without digits ARE pinned literally, which
//     is the bulk of every file here.
//  4. THE REAL GATE IS A HUMAN. With no backend, per-feed failure IS the state,
//     so a baseline legitimately contains "unavailable"-class copy inside data
//     panels. The automated guard below can only refuse to record a page that
//     failed OUTRIGHT. Whether the recorded copy is *right* is decided by
//     whoever reads the YAML in the diff. Never approve a baseline diff you
//     have not actually read.
//
// UPDATING. A real UI change makes this file fail until the baseline is
// re-approved:
//
//     bash scripts/e2e.sh tests/page-baseline.spec.ts --update-snapshots
//
// then READ the resulting diff before committing it. Blind --update-snapshots
// turns this file into a rubber stamp, which is the failure mode it is most
// exposed to.

// The 10 tab ids that render cleanly with no tenant, plus the hidden dossier
// page. Measured 2026-08-12 by `bash scripts/e2e.sh tests/tabs-smoke.spec.ts`
// with no credentials: 10 passed, 5 failed.
const COVERED = [
  'overview', 'daily', 'network', 'dns', 'security',
  'infra', 'assets', 'incidents', 'audit', 'ai',
];

// #dossier is routable but not in the nav (HIDDEN_PAGES, ui/src/App.jsx) and it
// is a view OF a search, so it needs a query to have anything to be. The literal
// is fixed and meaningless on purpose — it must never resolve to real tenant data.
const DOSSIER_QUERY = 'dossier?q=baseline.example';

// The five tabs with NO baseline, and why. These are declared as skipped tests
// rather than omitted, so `no baseline` appears in the run output every time
// and the hole cannot be forgotten. All five fail tabs-smoke credential-free
// for the same measured reason: their upstream calls die on
// `dial tcp: lookup csp.invalid: no such host` and the resulting console errors
// are real errors, not empty states. They are the tier-2 fixture work, and they
// are FIRST in that queue because they are the write-capable tabs.
const UNPROVEN = ['changes', 'provision', 'selfservice', 'editor', 'drift'];

// Pinned, because the ubuntu CI runner does not share a laptop's locale or zone
// and any rendered date would differ between the two.
test.use({ timezoneId: 'UTC', locale: 'en-US' });

// A fixed instant. Pinning the zone alone does NOT stabilise anything derived
// from Date.now() — a "2 minutes ago" label crosses a threshold between two
// captures taken a minute apart and the baseline flaps for no reason.
// setFixedTime, not clock.install: install() also fakes timers, which stalls
// the polling this app does on several tabs.
const FIXED_NOW = new Date('2026-01-01T12:00:00Z');

test.beforeEach(async ({ page }) => {
  // This file may only run against the disposable harness. scripts/e2e.sh
  // exports NOC_BASE and blanks every credential; a bare `npx playwright test`
  // falls through to scripts/dev-serve.sh on :8090, which has the operator's
  // REAL tenant and their REAL saved layouts. Baselines captured there would be
  // full of live data and would fail on every other machine forever.
  const base = process.env.NOC_BASE;
  expect(
    base,
    'page-baseline may only run under scripts/e2e.sh — NOC_BASE is unset, so this would ' +
      'capture the :8090 dev server (real tenant, real saved layouts). Run: bash scripts/e2e.sh tests/page-baseline.spec.ts',
  ).toBeTruthy();
  expect(
    base,
    `page-baseline must not run against ${base}: :8080 is the published image and :8090 is the dev server. ` +
      'Both carry live state. Use scripts/e2e.sh.',
  ).not.toMatch(/:(8080|8090)(\/|$)/);

  await page.clock.setFixedTime(FIXED_NOW);
});

/**
 * Everything that must be true before a page is allowed to become a baseline.
 * Returns the <main> locator to snapshot.
 *
 * The saved-view check is not paranoia: every tab now has a `__layout_<id>`
 * record, and a saved one REORDERS the panels. Capturing with one present would
 * bake one machine's saved arrangement into a file everyone else is measured
 * against. scripts/e2e.sh points VAULT_DIR at a temp dir so there should be
 * none — this asserts that rather than trusting it.
 */
async function readyMain(page: import('@playwright/test').Page, layoutKey: string) {
  const saved = await page.request.get(`/api/views/__layout_${layoutKey}`);
  expect(
    saved.status(),
    `a saved layout exists for "${layoutKey}" — it would reorder the panels and poison this baseline`,
  ).not.toBe(200);

  // The page rendered something of its own. TabLoading is aria-hidden, so a
  // snapshot taken during it would be near-empty rather than obviously wrong;
  // waiting on a real h1 is what rules that out.
  const heading = page.locator('h1').first();
  await expect(heading).toBeVisible();
  await expect(heading).not.toHaveText('');

  // The whole-tab failure state (TabErrorBoundary, ui/src/App.jsx). Its copy is
  // stable, so without this check it would snapshot happily and this file would
  // certify a broken tab forever.
  await expect(
    page.getByRole('alert').filter({ hasText: 'This tab could not load' }),
    'the tab error boundary is on screen — refusing to record a failed page as the baseline',
  ).toHaveCount(0);

  // <main> only. The header, group nav, connection status and update button sit
  // outside it and carry live state; including them would guarantee flapping.
  // They have their own specs (nav-groups, header-help, theme).
  return page.getByRole('main');
}

for (const id of COVERED) {
  test(`page "${id}" body matches its baseline`, async ({ page }) => {
    await page.goto(`/#${id}`);
    const main = await readyMain(page, id);
    await expect(main).toMatchAriaSnapshot({ name: `${id}.aria.yml` });
  });
}

test('page "dossier" body matches its baseline', async ({ page }) => {
  await page.goto(`/#${DOSSIER_QUERY}`);
  // dossier is not a tab and owns no layout key; pass its id so the assertion
  // still proves no stray view exists under that name.
  const main = await readyMain(page, 'dossier');
  await expect(main).toMatchAriaSnapshot({ name: 'dossier.aria.yml' });
});

for (const id of UNPROVEN) {
  // eslint-disable-next-line no-empty-function
  test.fixme(`page "${id}" has NO baseline — upstream failure makes it unrecordable without fixtures`, async () => {
    // Deliberately empty. The title is the deliverable: it prints on every run
    // so the five uncovered pages stay visible. Promote these first when the
    // tier-2 fixtures land (plans/033-page-baselines.md).
  });
}
