import { test, expect } from './fixtures';

// A chart tab must be readable before its charting library arrives.
//
// THE COMPANION TO bundle-budget.spec.ts, NOT A DUPLICATE OF IT. That file
// guards the chart-FREE route (#provision) against the charts chunk leaking
// onto it. This one guards the seven chart tabs against the opposite failure:
// there the chunk is legitimately needed, and the question is whether the
// reader has to wait for all 392 kB of it before any of the page appears.
//
// WHAT IT USED TO DO. Every one of these tabs imported `recharts` at module top
// level, which made the charts chunk a static dependency of the TAB's chunk —
// so the browser fetched it before running a line of the tab. Measured against
// the built app on 2026-08-10, at 4 Mbps, stopwatch stopping when the tab's own
// <h1> is on screen:
//
//   tab         before              after
//   overview    2108 ms / 712 KB    1608 ms / 338 KB
//   security    2101 ms / 721 KB    1595 ms / 339 KB
//   incidents   2149 ms / 714 KB    1593 ms / 332 KB
//   audit       2101 ms / 711 KB    1598 ms / 329 KB
//   (provision, which has no chart at all, is 1591 ms / 343 KB)
//
// The fix was to move each chart body into ui/src/charts/*.jsx behind
// `lazy(() => import(...))`, so a chart tab now costs what a chart-free tab
// costs and the chart fills in afterwards.
//
// WHY THE ASSERTION IS "before the heading" AND NOT A BYTE TOTAL. Lazy loading
// does not remove the chunk — the chart still renders, so the same bytes still
// arrive. A total-bytes-per-tab measurement shows NO improvement and is the
// wrong instrument; it was tried first and reported a clean bill of health for
// a build that had not changed at all. The property that matters, and the only
// one that changed, is whether those bytes are on the critical path.
// WHY THE NETWORK IS THROTTLED, AND WHY THE FIRST VERSION OF THIS FILE WAS
// FLAKY WITHOUT IT. Against an unthrottled dev server on loopback every chunk
// arrives within a frame or two of every other, so "did the charts chunk get
// here before the heading" becomes a coin toss decided by scheduling rather
// than by the dependency graph — 4 of these 7 tests came back flaky on the
// first run. tests/tab-switch-no-flash.spec.ts holds the same shape of problem
// and solves it the same way. Throttling restores the ordinary condition the
// behaviour exists for: a network where 392 kB actually takes time.
//
// 4 Mbps / 40 ms is slow enough to separate the two events by a wide margin
// (measured: heading at ~1.6s, charts chunk still in flight) and fast enough
// that seven tabs run in under 20 seconds.
const THROTTLE = {
  offline: false,
  downloadThroughput: (4 * 1024 * 1024) / 8,
  uploadThroughput: (1024 * 1024) / 8,
  latency: 40,
};

const CHART_TABS: [string, string][] = [
  ['overview', 'Overview'],
  ['security', 'Security'],
  ['network', 'Network'],
  ['dns', 'DNS'],
  ['incidents', 'Incidents'],
  ['audit', 'Audit'],
  ['infra', 'Infrastructure'],
];

for (const [tab, heading] of CHART_TABS) {
  test(`#${tab} is readable before the charts chunk arrives`, async ({ page }) => {
    let chartBytesBeforeHeading = 0;
    let anyJs = 0;
    let frozen = false;
    const pending: Promise<unknown>[] = [];

    page.on('response', (res) => {
      const path = new URL(res.url()).pathname;
      if (!path.endsWith('.js')) return;
      pending.push(
        res
          .body()
          .then((b) => {
            if (frozen) return;
            anyJs += b.length;
            if (/\/assets\/charts-/.test(path)) chartBytesBeforeHeading += b.length;
          })
          .catch(() => {}),
      );
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', THROTTLE);

    await page.goto(`/#${tab}`);
    await expect(page.locator('main h1')).toHaveText(heading);
    await Promise.all(pending);
    frozen = true;

    // Guards the guard: a run that fetched no JavaScript at all measured
    // nothing, and would report success for it.
    expect(
      anyJs,
      `no JavaScript was downloaded for #${tab}, so this test proved nothing — the page was ` +
        `probably served from a cache this spec did not expect.`,
    ).toBeGreaterThan(0);

    expect(
      chartBytesBeforeHeading,
      `#${tab} downloaded ${Math.round(chartBytesBeforeHeading / 1024)} KB of the charts chunk ` +
        `before its heading was on screen, so the reader waited for the charting library to ` +
        `render text that does not need it. The cause is a top-level \`import … from 'recharts'\` ` +
        `in ui/src/tabs/${heading}.jsx — move the chart body into ui/src/charts/ and pull it in ` +
        `with lazy(() => import(...)), as the other chart tabs do.`,
    ).toBe(0);
  });
}
