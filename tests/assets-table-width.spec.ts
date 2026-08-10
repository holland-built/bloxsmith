import { test, expect } from './fixtures';

// The Assets table must never be wider than the box that clips it — not by one
// pixel, at any viewport width.
//
// WHY THIS FILE EXISTS SEPARATELY FROM table-sizing.spec.ts, which already owns
// "no table overflows its scroll wrapper". That spec could not catch this bug
// and still cannot, for two independent reasons, both worth stating so nobody
// merges the two files and quietly loses the coverage:
//
//   1. It tolerates a pixel on purpose: `if (overflowPx > 1)`. That tolerance is
//      right for what it does — it reconciles two independent estimators across
//      94 panels — but it makes a 1px overflow unreportable by construction.
//   2. Its TABS list has no 'assets' entry, and the live Assets feed takes ~10s
//      against a real tenant, close enough to the UI's 12s abort budget that a
//      spec depending on it would be flaky. The rows here are stubbed instead,
//      which is also what makes a 400-width sweep affordable.
//
// WHY A SWEEP AND NOT A LIST OF WIDTHS. Whether the pixel appears depends on the
// fractional parts of the computed column widths, so it is a property of the
// exact viewport width and of nothing else. A handful of round sample widths
// (1024/1280/1600/1920) hit none of the seven widths that actually failed —
// measured: adding those seven to table-sizing.spec.ts and reverting the fix
// still passed 16/16, because each tab's columns fail at their own widths.
// Sampling cannot find this class of bug. Sweeping can.
//
// THE BUG THIS PINS (fixed 2026-08-10, DataTable.jsx's allocator). Column widths
// were rounded one at a time with Math.round. The fractional widths add up to
// the budget exactly; five independent roundings do not. At 806px the columns
// came out 187+144+128+115+147 = 721 in a 720px wrapper. Because the wrapper is
// `overflow-x-hidden`, that surplus is not a scrollbar — it is a column edge
// clipped where nobody can see it. The allocator now rounds the columns as a set
// (largest-remainder), so the total is the budget by construction.
//
// The seven failing widths were 767, 806, 926, 931, 960, 990 and 1000. The range
// below covers all of them with room either side; every width in it passed after
// the fix, and this file fails at seven of them without it.

const NAMES = [
  'debug-vpcflow', 'ip-10-0-14-221.ec2.internal', 'DESKTOP-4F9K2LQ',
  'sholland-macbook-pro-16-inch-2023', 'prod-db-replica-eu-west-1c',
  'wireless-ap-floor3-northwing-0042', 'svc-backup-agent', 'iphone-15-pro-max',
];
const TYPES = ['Storage Bucket', 'Workstation', 'Virtual Machine', 'Laptop', 'Smartphone'];
const PROVIDERS = ['AWS', 'Microsoft Azure', 'Google Cloud Platform', 'On-premises'];
const VENDORS = ['AWS', 'Dell Inc.', 'Apple, Inc.', 'Cisco Systems, Inc.'];

// Shaped from a real /api/csp/assets response captured 2026-08-10, with the
// names widened to realistic worst cases. The column set is what matters: five
// columns is what makes the rounding error reachable.
function assetsStub() {
  return {
    availability: 'ok', dir: 'desc', has_more: true, page: 0, page_size: 50,
    sort: 'last_seen', total: 2375,
    rows: Array.from({ length: 50 }, (_, i) => ({
      cqid: `stub-${i}`,
      last_seen: '2026-08-10T17:54:44.000',
      name: NAMES[i % NAMES.length],
      provider: PROVIDERS[i % PROVIDERS.length],
      type: TYPES[i % TYPES.length],
      vendor: VENDORS[i % VENDORS.length],
    })),
  };
}

const FROM = 760;
const TO = 1200;

test('the Assets table never overflows its wrapper, at any width', async ({ page }) => {
  test.setTimeout(180000);

  await page.route('**/api/csp/assets*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(assetsStub()) }));
  await page.route('**/api/csp/asset-filters*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        availability: 'ok',
        total: 2375,
        types: TYPES.map((label, i) => ({ label, count: 100 * (i + 1) })),
      }),
    }));

  await page.setViewportSize({ width: 1279, height: 900 });
  await page.goto('/#assets');
  await expect(page.locator('main h1')).toBeVisible();
  await page.locator('main table').first().waitFor({ state: 'visible', timeout: 20000 });

  const offenders: string[] = [];
  let measured = 0;

  for (let w = FROM; w <= TO; w++) {
    await page.setViewportSize({ width: w, height: 900 });
    // Two frames: one for the browser's layout, one for the ResizeObserver's own
    // rAF in DataTable to land its recomputed widths.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
    );

    const m = await page.evaluate(() => {
      const table = document.querySelector('main table') as HTMLElement | null;
      if (!table) return null;
      const wrapper = table.parentElement as HTMLElement;
      const ths = Array.from(table.querySelectorAll('thead th')) as HTMLElement[];
      return {
        over: wrapper.scrollWidth - wrapper.clientWidth,
        budget: wrapper.clientWidth,
        cols: ths.map((th) => Math.round(th.getBoundingClientRect().width)),
      };
    });

    if (!m) continue;
    measured++;
    if (m.over > 0) {
      offenders.push(
        `${w}px: table is ${m.over}px wider than its ${m.budget}px wrapper ` +
          `(columns ${m.cols.join('+')} = ${m.cols.reduce((a, b) => a + b, 0)})`,
      );
    }
  }

  // A sweep that measured nothing would report a clean result. Say so instead.
  expect(
    measured,
    `no width in ${FROM}-${TO} produced a measurable table, so this sweep proved nothing. ` +
      `The Assets stub above has probably stopped matching what the tab requests.`,
  ).toBeGreaterThan(TO - FROM - 5);

  expect(
    offenders,
    `the Assets table overflowed its wrapper at ${offenders.length} of ${measured} widths. ` +
      `Because the wrapper is overflow-x-hidden this is clipped data, not a scrollbar. ` +
      `The usual cause is DataTable's allocator rounding column widths one at a time ` +
      `instead of as a set.\n${offenders.slice(0, 15).join('\n')}`,
  ).toEqual([]);
});
