import { test, expect } from './fixtures';

// The Top Subnets panel must not resize when its rows arrive.
//
// WHAT WENT WRONG. While /api/data was in flight the panel rendered <Empty/>,
// which stands about 72px tall; the DataTable that replaced it stands 420px
// (its own maxHeight) on any estate with enough subnets to overflow. The panel
// therefore jumped ~350px at the moment the payload landed, shoving everything
// below it down the page.
//
// Measured with Lighthouse 13.4.1 on 2026-08-27 against http://localhost:8090/
// #overview with --preset=desktop: Cumulative Layout Shift 0.199 against a 0.1
// threshold, of which 0.1988 was attributed to this one element
// (data-panel-id="subnet-table").
//
// WHY THE DEFAULT LIGHTHOUSE RUN NEVER SAW IT. The mobile profile scored CLS
// 0.004. At 390px wide the panel sits below the fold when it grows, and a shift
// of content that was never in the viewport does not score. The finding is
// desktop-only, and the audit that recorded "LCP 8.7s" as this page's problem
// was reading the mobile profile, which is why it missed this.
//
// TWO PAYLOADS, AND THE SECOND ONE IS THE POINT. A skeleton sized to the 420px
// cap fixes the overflowing estate and BREAKS the short one: maxHeight pins the
// table's height only when there are enough rows to reach it, so a three-subnet
// estate renders a ~200px table under a 420px skeleton and the panel collapses
// instead of growing. Same shift, other direction, and for a small estate a
// bigger one than the bug. The fix is minHeight alongside maxHeight; SHORT
// below is what holds it honest, and it fails against a minHeight-less version.
//
// WHY THIS SPEC BUILDS ITS OWN SUBNETS INSTEAD OF USING THE FIXTURE'S.
// tests/page-fixtures.ts ships THREE subnets on purpose — the YAML baselines
// are read by humans in a diff and 500 synthetic rows would make them
// unreadable. Three rows never reach the 420px cap, so against the fixture
// estate the original defect does not reproduce at all and this spec would pass
// against the broken code. That is the "a floor in a test must come from the
// world the test runs in" mistake, and the fix is for the spec to supply both
// worlds its floors come from.
//
// 60 rows for OVERFLOW: at roughly 34px a row that is ~2,000px of table,
// comfortably past the cap. The live tenant reports 72,299 subnets, so
// overflowing is the ordinary case. 3 rows for SHORT, matching the smallest
// estate the fixtures describe.
const OVERFLOW_ROWS = 60;
const SHORT_ROWS = 3;

function subnetsFor(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ipam/subnet/cls-${i}`,
    addr: `10.${i}.0.0`,
    cidr: 24,
    name: `cls-net-${i}`,
    site: i % 2 === 0 ? 'site-a' : 'site-b',
    total: 254,
    used: 25 + i,
    util: 10 + (i % 80),
  }));
}

function payloadFor(n: number) {
  return {
    subnets: subnetsFor(n),
    leases: [], hosts: [], zones: [], dnsViews: [], secPolicies: [], feeds: [], auditLogs: [],
    _totals: { degraded: false, subnets: n, hosts: 0, subnetsCrit: 1, subnetsWarn: 1 },
    _meta: {
      subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok',
      hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok',
    },
  };
}

// Long enough to measure the in-flight panel without racing it, short enough
// that the total hold stays well inside the 12s browser budget in
// ui/src/lib/api.js — crossing it would abort the request and put the panel
// into its ERROR branch, which is a different box and not what this file is
// about. The request is held from the moment it is intercepted until this timer
// fires AFTER the loading-state measurement, so the real hold is HOLD_MS plus
// navigation and that measurement: at least HOLD_MS, not exactly it.
const HOLD_MS = 1500;

// 32px, and the reason is a SECOND cause this fix does not touch.
//
// Measured on 2026-08-27 with the reservation in place: the panel's content
// region is 420px in both states, exactly as intended — but the panel still
// moves 28px, from 500px to 528px. The whole 28px is the Card's header, which
// is `flex flex-wrap` and holds the row count beside the filter box, the site
// select and Export CSV. In flight the count reads "0 loaded"; loaded it reads
// "showing 60 of 60". The longer string pushes the toolbar onto a second line
// and the header goes 34px -> 62px.
//
// That is a text-length reflow in a toolbar, not an unreserved table, and
// fixing it means restyling the panel header — moving a control's box, which
// docs/SCREENS.md puts behind a variant set and the owner naming one. It is
// recorded as its own finding rather than smuggled in here.
//
// So the claim this file is entitled to make is "the table no longer resizes
// the panel; what is left is one toolbar row". It still fails loudly against
// the defect it was written for: that one was 348px, twelve times this.
const MAX_DELTA_PX = 32;

for (const [label, rowCount] of [
  ['an estate that overflows the table cap', OVERFLOW_ROWS],
  ['an estate too small to reach it', SHORT_ROWS],
] as const) {
  test(`the Top Subnets panel keeps its height when rows arrive: ${label}`, async ({ page }) => {
    // Desktop width deliberately: the shift scores only where the panel is in
    // the viewport, and 1440x900 is where the 0.199 was measured.
    await page.setViewportSize({ width: 1440, height: 900 });

    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });

    await page.route('**/api/data*', async (route) => {
      // Answered from here rather than forwarded. tests/assets-cold-load.spec.ts
      // records why at length: continue() adds the real tenant's mood to the
      // hold, which made a sibling spec flaky by reproducing the very timing it
      // was written to rule out.
      await held;
      return route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(payloadFor(rowCount)),
      });
    });

    await page.goto('/#overview');

    const panel = page.locator('[data-panel-id="subnet-table"]');
    await expect(panel).toBeVisible();

    // IN FLIGHT. The title is up, the payload is not. Asserting the loading box
    // is actually on screen first means a delta of zero cannot come from having
    // measured the wrong moment.
    await expect(panel.getByText('Top Subnets by Utilization')).toBeVisible();
    const loadingBox = await panel.boundingBox();
    expect(loadingBox, 'the panel must be laid out while /api/data is in flight').not.toBeNull();

    setTimeout(() => release?.(), HOLD_MS);
    // The count in the panel header: one stable node whose text is unique to
    // this payload, so it pins that what the route served is what is on screen.
    await expect(panel.getByText(`showing ${rowCount} of ${rowCount}`)).toBeVisible();
    // The top row under the table's own default sort (util, descending), which
    // is the LAST index, not the first. Its cell shows the ADDRESS, because the
    // Network column renders `s.addr`; the row's `name` appears nowhere on
    // screen, so asserting on it would be the "a label must name something the
    // reader can SEE" mistake in locator form.
    await expect(panel.getByText(`10.${rowCount - 1}.0.0`)).toBeVisible();

    const loadedBox = await panel.boundingBox();
    expect(loadedBox).not.toBeNull();

    // ABSOLUTE, not signed. A panel that collapses shifts the page exactly as
    // much as one that grows, and the minHeight half of this fix exists
    // precisely because the first attempt traded one direction for the other.
    const delta = loadedBox!.height - loadingBox!.height;
    expect(
      Math.abs(delta),
      `the panel changed height by ${Math.round(delta)}px when its rows landed ` +
        `(${Math.round(loadingBox!.height)}px -> ${Math.round(loadedBox!.height)}px). Everything below ` +
        `it on the page moved by that much, which is the 0.199 desktop CLS this spec exists to hold down.`,
    ).toBeLessThanOrEqual(MAX_DELTA_PX);
  });
}
