import { test, expect } from './fixtures';

// What a first-time visitor to #provision has to download before the tab can
// draw. Provision is the chart-free tab the "+ Provision" header button points
// at, so it is the cheapest route the app has — and before the code split it
// was also the most expensive, because there was only one route: every visitor
// downloaded all 15 tabs plus recharts no matter which tab they opened.
//
// MEASURED, NOT GUESSED. Both numbers come from a cold-cache Chromium load
// against the dev server on :8090, summing the body bytes of every .js
// response, on 2026-08-10:
//
//   before the split   924,726 B  (903.1 KB)  — one index-*.js carrying all 15
//                                               tabs plus recharts
//   after the split    351,440 B  (343.2 KB)  — vendor-react 189,596
//                                               + entry 125,007
//                                               + Provision 18,869
//                                               + SelfService 16,672
//                                               + runtime/authFetch 1,296
//
// SelfService is on that list because tabs/Provision.jsx imports FetchError
// from tabs/SelfService.jsx — a real static import between two tab modules that
// predates this split. It is 16.7 kB and left alone deliberately; if it is ever
// worth removing, that is its own change, not this one.
//
// The budget is the measured figure plus ~10% headroom: loose enough that
// ordinary edits to a tab do not trip it, tight enough that the regression that
// matters cannot hide. That regression is the charts chunk (392,674 B) leaking
// back onto a chart-free route — which is not hypothetical, it is what this
// build did on the first attempt, when the `charts` group was declared before
// `vendor-react` and therefore swallowed React itself, forcing the entry chunk
// to preload all of recharts on every route (#provision measured 744,394 B).
//
// If this fails, do not raise the number until you know WHICH chunk grew: the
// failure message lists every .js file fetched and its size.
const BUDGET_BYTES = 380 * 1024; // 389,120 B

test('#provision downloads less JavaScript than the committed budget', async ({ page }) => {
  const bytes = new Map<string, number>();
  const pending: Promise<unknown>[] = [];

  page.on('response', (res) => {
    const path = new URL(res.url()).pathname;
    if (!path.endsWith('.js')) return;
    // Keyed by path so a redirect or a repeat request cannot double-count.
    pending.push(
      res
        .body()
        .then((b) => bytes.set(path, b.length))
        .catch(() => {
          /* body already discarded — it simply does not count */
        }),
    );
  });

  await page.goto('/#provision');
  // The tab's own chunk is fetched after the entry chunk parses, so waiting for
  // the heading is what makes this a measurement of "everything #provision
  // needed", not "everything that happened to arrive first".
  await expect(page.locator('h1')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await Promise.all(pending);

  const total = [...bytes.values()].reduce((a, b) => a + b, 0);
  const breakdown = [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `  ${String(n).padStart(8)} B  ${p}`)
    .join('\n');

  expect(
    total,
    `#provision pulled ${total} B of JavaScript, over the ${BUDGET_BYTES} B budget.\n` +
      `Chunks fetched:\n${breakdown}`,
  ).toBeLessThanOrEqual(BUDGET_BYTES);
});
