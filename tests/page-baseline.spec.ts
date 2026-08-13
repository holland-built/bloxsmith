import { test, expect } from './fixtures';
import { installFixtures, HAS_FIXTURES, FIXED_NOW } from './page-fixtures';

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

// #dossier is routable but not in the nav (HIDDEN_PAGES, ui/src/App.jsx) and it
// is a view OF a search, so it needs a query to have anything to be. The literal
// is fixed and meaningless on purpose — it must never resolve to real tenant data.
const DOSSIER_QUERY = 'dossier?q=baseline.example';

// Pages with NO baseline, and why. Declared as skipped tests rather than omitted,
// so the hole prints on every run and cannot be forgotten.
//
// EMPTY as of 2026-08-13, and kept anyway. It held five tabs — changes,
// provision, selfservice, editor, drift — which had no baseline at all because
// their upstream calls died on `dial tcp: lookup csp.invalid: no such host`.
// Fixtures closed all five. The list stays so the next page that turns out to be
// unrecordable gets DECLARED here with its measured reason instead of quietly
// never being added.
const UNPROVEN: string[] = [];

// Pinned, because the ubuntu CI runner does not share a laptop's locale or zone
// and any rendered date would differ between the two.
test.use({ timezoneId: 'UTC', locale: 'en-US' });

// FIXED_NOW is imported from page-fixtures.ts rather than declared here, and
// that is load-bearing: the fixtures' timestamps are computed from it, so if the
// browser clock and the fixture clock were two different constants every faked
// row would be hours adrift from "now" and the 24-hour windows would be empty.
// Pinning the zone alone does NOT stabilise anything derived from Date.now() —
// a "2 minutes ago" label crosses a threshold between two captures taken a
// minute apart and the baseline flaps for no reason. setFixedTime, not
// clock.install: install() also fakes timers, which stalls the polling this app
// does on several tabs.

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
  // DELETE first, then assert it is gone — stronger than asserting absence, and
  // changed after a measured failure. Under the plan-036 probe, with
  // layout-drag.spec.ts and layout-persist.spec.ts no longer excluded, this
  // assertion fired on Linux: those specs own `__layout_overview`, and
  // layout-persist SIGTERMs the server mid-test, so a failed run can leave its
  // saved view behind. Asserting absence made a real leftover break an unrelated
  // baseline; deleting guarantees the known-good starting state instead of
  // failing on someone else's mess. The guard is not weakened — capturing a
  // baseline with a saved layout is still impossible, it is now impossible by
  // construction rather than by complaint.
  await page.request.delete(`/api/views/__layout_${layoutKey}`).catch(() => {});
  const saved = await page.request.get(`/api/views/__layout_${layoutKey}`);
  expect(
    saved.status(),
    `a saved layout for "${layoutKey}" survived deletion — it would reorder the panels and poison this baseline`,
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

// ---------------------------------------------------------------------------
// Every routable page, driven to a healthy state with fake API responses.
//
// There used to be a second, weaker loop above this one for pages captured with
// no backend at all. It is gone: every page has fixtures now, so keeping a
// no-backend path would only leave a way for a new page to get the weak
// treatment by default. A page with no fixtures belongs in UNPROVEN, declared
// and visible, not silently baselined against a wall of "feed unavailable".
// ---------------------------------------------------------------------------
for (const id of HAS_FIXTURES) {
  test(`page "${id}" body matches its baseline (healthy, faked backend)`, async ({ page }) => {
    const fx = await installFixtures(page, id);
    await page.goto(id === 'dossier' ? `/#${DOSSIER_QUERY}` : `/#${id}`);
    const main = await readyMain(page, id);

    // Every /api/ call the page made was one this fixture set knows about. An
    // unmatched request means the page asked for something new — a real change
    // worth failing on, and one a snapshot alone would not necessarily show.
    expect(fx.unmatched(), 'unmatched /api/ requests — add them to tests/page-fixtures.ts').toEqual([]);
    // And the reverse: a panel that was deleted stops calling its endpoint. The
    // snapshot would change too, but this names the cause instead of leaving
    // someone to diff YAML and guess.
    expect(fx.neverCalled(), 'fixtures that were never requested — did a panel disappear?').toEqual([]);

    // With every feed reporting ok, the failure copy that tier-1 baselines are
    // full of must be absent. This is the guard tier 1 could not have: it is
    // what stops a broken page being recorded as normal.
    await expect(
      main.getByText(/feed unavailable|unavailable\b/i),
      'a feed is reporting unavailable despite every fixture returning ok',
    ).toHaveCount(0);

    await expect(main).toMatchAriaSnapshot({ name: `${id}.aria.yml` });
  });
}

for (const id of UNPROVEN.filter((x) => !HAS_FIXTURES.includes(x))) {
  // eslint-disable-next-line no-empty-function
  test.fixme(`page "${id}" has NO baseline — upstream failure makes it unrecordable without fixtures`, async () => {
    // Deliberately empty. The title is the deliverable: it prints on every run
    // so an uncovered page stays visible.
  });
}
