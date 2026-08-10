import { test, expect } from './fixtures';

// The Assets tab must survive its own cold read.
//
// WHAT WENT WRONG. /api/csp/assets and /api/csp/asset-filters are Cube.js reads
// held in a 5-minute server cache that nothing keeps warm — this tab
// deliberately does not poll — so any visit more than five minutes after the
// last one pays full price. Measured cold against the live tenant 2026-08-10:
// 11.2s, 11.0s and 18.5s for the inventory read, 9.4s for the filters, against
// a 12s browser budget. The tab therefore showed "Asset inventory unavailable"
// perhaps half the time, for a read that had not failed and was still coming.
// The server finished and cached it regardless, so an immediate Refresh always
// worked — which is exactly what made the failure look random rather than
// systematic.
//
// WHY THE DELAY IS INJECTED RATHER THAN WAITED FOR. Reproducing this honestly
// would mean idling out a 5-minute TTL before every run, and would then depend
// on the live tenant's mood for its timing. Instead both endpoints are held for
// COLD_HOLD_MS on their FIRST call only and answered from the real server after
// that, which reproduces the one property that matters — a first read slower
// than the old 12s budget — deterministically and in a few seconds.
//
// 15s is chosen to sit above the old 12s budget and below the new 30s one, so
// this file fails if the override is removed and passes while it is there. It
// is not a claim that the real endpoint takes 15s; the real numbers are above.
const COLD_HOLD_MS = 15000;

test('a cold Assets read that outlives the old budget still renders', async ({ page }) => {
  test.setTimeout(180000);

  let heldList = false;
  let heldFilters = false;

  await page.route('**/api/csp/assets*', async (route) => {
    if (!heldList) {
      heldList = true;
      await new Promise((r) => setTimeout(r, COLD_HOLD_MS));
    }
    await route.continue();
  });
  await page.route('**/api/csp/asset-filters*', async (route) => {
    if (!heldFilters) {
      heldFilters = true;
      await new Promise((r) => setTimeout(r, COLD_HOLD_MS));
    }
    await route.continue();
  });

  // WHAT THIS ASSERTS, AND WHY IT IS NOT "the table eventually appears".
  // Measured while writing this file: with the override REMOVED the table still
  // appears, because the 12s abort is classified transient (api.js
  // isTransientError) and the retry ~2s later hits the answer the server has by
  // then finished and cached. So "does data arrive" cannot tell the two builds
  // apart, and a spec asserting only that passes either way — it was written
  // that way first and did exactly that.
  //
  // What actually differs is what the operator SEES on the way: without the
  // override the panel puts up "Asset inventory unavailable" — a statement that
  // the feed is broken — for a read that was merely slow, and then quietly
  // replaces it with data. That false claim is the bug, so that is the
  // assertion. The sampler watches for the failure copy for the whole load
  // rather than checking once at the end, because it is transient by nature.
  const failureSeen: string[] = [];
  const watch = setInterval(async () => {
    for (const phrase of ['Asset inventory unavailable', 'Asset filter feed unavailable']) {
      try {
        if (await page.getByText(phrase).count()) failureSeen.push(phrase);
      } catch { /* page mid-navigation */ }
    }
  }, 250);

  await page.goto('/#assets');
  await expect(page.locator('main h1')).toHaveText('Assets');

  const table = page.locator('main table').first();
  await table.waitFor({ state: 'visible', timeout: 90000 });
  await expect(table.locator('tbody tr').first()).toBeVisible();
  clearInterval(watch);

  expect(heldList, 'the inventory read was never held, so nothing was proven').toBe(true);
  expect(heldFilters, 'the filter read was never held, so nothing was proven').toBe(true);

  expect(
    [...new Set(failureSeen)],
    `the panel claimed the feed was unavailable while a slow-but-healthy read was still in ` +
      `flight. A read that has not finished is not a read that failed — give the slow ` +
      `endpoints their longer cold budget (api.js SLOW_COLD_TIMEOUT_MS) rather than telling ` +
      `the operator something is broken when it is not.`,
  ).toEqual([]);
});
