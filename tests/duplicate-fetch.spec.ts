import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// /api/data MUST NOT BE FETCHED TWICE ON ONE PAGE LOAD.
//
// WHAT WENT WRONG. Two mounted components asked for the same url on every
// Overview load. Measured on the live tenant 2026-08-27 from a Playwright
// request trace:
//
//   t=40ms   ConnStatus, the status dot in the header, poll 60000
//   t=330ms  the Overview tab itself,                  poll 30000
//
// Same url, same body, twice — 1.61MB each against a warmed dev server. Over a
// 65-second window the unfixed page made FIVE requests (mount x2, the 30s poll,
// then the 60s and 30s polls drifting into each other at t=60.0s and t=60.3s).
// It doubles the server's work on its largest endpoint on every cycle, forever.
//
// They are not concurrent — 290ms apart — so de-duplicating in-flight requests
// would not catch it. `adoptIfFresherThan` in ui/src/lib/api.js does: whichever
// of the two asks second finds a result the other finished moments ago and takes
// it instead of fetching.
//
// WHAT THIS SPEC CAN AND CANNOT PROVE. Adoption needs a SETTLED result, so it
// collapses the duplicate only on a warm read. On a genuinely cold /api/data
// (3.5-7.5s, measured in api.js's own header) ConnStatus is still in flight when
// Overview mounts, nothing has settled, and both fetch exactly as before. The
// fixture answers instantly, so what is asserted here is the warm path — which
// is the one that repeats every poll cycle for the life of the session, and so
// the one the server cost actually lives in. The cold first load is a known,
// deliberate gap, not an oversight.
//
// The 65-second steady-state numbers are in plans/gui-screens-audit.md beside
// finding 9; they need a real tenant and two real poll intervals, which is more
// than this suite should spend.

test('one page load makes one /api/data request, not two', async ({ page }) => {
  await installBaselineWorld(page);

  // Counted at the network layer rather than by watching the hook, because what
  // the finding is about is requests leaving the browser. installBaselineWorld
  // has already registered a handler for this path; Playwright matches
  // newest-first, so this one sees the request, counts it, and falls through.
  let count = 0;
  await page.route('**/api/data', async (route) => {
    count += 1;
    await route.fallback();
  });

  await page.goto('/#overview');

  // Both askers must have had their turn before this is counted. ConnStatus is
  // in the header and mounts with the shell; Overview mounts with the tab, and
  // it is the later of the two, so waiting for a panel that depends on the
  // payload waits for both.
  await expect(page.locator('[data-panel-id="top-consumers"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-panel-id="host-status"] .w-\\[130px\\]')).toBeVisible({ timeout: 20_000 });
  // A moment past the render, so a second request issued just after the first
  // one resolved is still caught rather than missed by measuring too early.
  await page.waitForTimeout(1000);

  expect(count, `/api/data was requested ${count} times for one page load`).toBe(1);

  // BOTH askers must actually have their data. A count of 1 is also what you
  // would see if one of them silently never got an answer, which is a worse bug
  // than the duplicate this spec exists to prevent — so the count alone is not
  // the whole assertion.
  //
  // The Overview side: a panel that can only render from the payload.
  await expect(page.locator('[data-panel-id="host-status"]')).toContainText(/hosts/);

  // The ConnStatus side, read off the one thing on it that is data-dependent.
  // Its title is built from `lastFetchRef`, which is only ever set when
  // `hasData` is true, and reads "never" until then. So "last data fetch 3s ago"
  // is proof the dot got a payload, and it is proof specifically for the caller
  // that adopted rather than fetched. Its visible label is no good here: below
  // the `lg` breakpoint the words are hidden and only the dot survives.
  const dot = page.locator('[title*="last data fetch"]').first();
  await expect(dot).toHaveAttribute('title', /last data fetch \d+s ago/);
  await expect(dot).not.toHaveAttribute('title', /last data fetch never/);
});

// A feed that nothing shares still fetches exactly once — the ordinary case, and
// a check that the new code path in load() did not start swallowing requests for
// urls it has nothing cached for.
//
// This does NOT prove that a non-opting call site is immune to adoption: only
// one component asks for this url, so there would be nothing for it to adopt
// even if adoption were the default. That guarantee is a unit test
// ('nothing is retained for a url that no adopter is watching' in
// ui/src/lib/api.test.js), where two callers of one url can actually be staged.
test('a feed that nothing shares still fetches exactly once', async ({ page }) => {
  await installBaselineWorld(page);

  const seen: string[] = [];
  await page.route('**/api/csp/dns-qps', async (route) => {
    seen.push('dns-qps');
    await route.fallback();
  });

  await page.goto('/#overview');
  await expect(page.locator('[data-panel-id="dns-hero"]')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);

  expect(seen.length, 'the DNS feed is not shared with anything and must fetch normally').toBe(1);
});
