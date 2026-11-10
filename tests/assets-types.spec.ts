import { test, expect } from './fixtures';
import type { Route } from '@playwright/test';

// The Assets page's type breakdown and its Unclassified headline (2026-11).
//
// The whole-app review found "636 unclassified assets (29%) shown as one grey
// chip among 37": the gap on the page was the least visible thing on it. These
// tests hold the redesign to that finding: the unclassified count and share are
// a headline that shows them in one click, the types read largest first with
// the long tail folded behind "+N more", and Last seen is an age that fits.
//
// Expected numbers are worked out by hand from TYPES below, not by the page's
// own arithmetic: 636 of 2,204 is 28.9%, shown as 29%; 516 is 23.4%, 23%; one
// is 0.05%, shown as <0.1%; 37 types minus the top 8 leaves 29.

const TYPES: [string, number][] = [
  ['Smart TV', 6], ['Unclassified', 636], ['Storage Volume', 237], ['Cloud Security Group', 516],
  ['Virtual Machine', 233], ['Internet Gateway', 144], ['Public IP Address', 121], ['Server', 64],
  ['Storage Bucket', 44], ['Workstation', 41], ['Router', 38], ['End User Device', 33],
  ...Array.from({ length: 25 }, (_, i): [string, number] => [`Tail type ${String(i).padStart(2, '0')}`, 1]),
];
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setup(page: import('@playwright/test').Page) {
  const asked: string[] = [];
  await page.clock.setFixedTime(NOW);
  await page.route('**/api/csp/asset-filters*', (r) =>
    json(r, { availability: 'ok', total: 2204, types: TYPES.map(([label, count]) => ({ label, count })) }));
  await page.route('**/api/csp/assets*', (r) => {
    asked.push(r.request().url());
    return json(r, {
      availability: 'ok', dir: 'desc', has_more: false, page: 0, page_size: 50, sort: 'last_seen', total: 1,
      // Zoneless UTC, the way Cube.js sends it: 8 hours before NOW.
      rows: [{ cqid: 'cq-1', last_seen: '2026-08-10T04:00:00.000', name: 'host-1', provider: 'AWS', type: 'Server', vendor: 'AWS' }],
    });
  });
  return asked;
}

test('Unclassified is a headline with its share, and one click shows them', async ({ page }) => {
  const asked = await setup(page);
  await page.goto('/#assets');

  const tile = page.getByRole('list', { name: 'Headline numbers' }).getByRole('link', { name: /^Unclassified/ });
  await expect(tile).toContainText('636');
  await expect(tile).toContainText('29% of all');
  await tile.click();

  await expect(page).toHaveURL(/#assets\?type=Unclassified$/);
  await expect.poll(() => asked.some((u) => new URL(u).searchParams.get('type') === 'Unclassified')).toBe(true);
  const bar = page.locator('[data-panel-id="assets-filter-bar"]');
  await expect(bar.getByRole('button', { name: /^Unclassified/ })).toHaveAttribute('aria-pressed', 'true');

  // Pressing the chosen row again clears the filter.
  await bar.getByRole('button', { name: /^Unclassified/ }).click();
  await expect(page).toHaveURL(/#assets$/);
});

test('types read largest first, top eight, with the rest behind "+29 more"', async ({ page }) => {
  await setup(page);
  await page.goto('/#assets');

  const list = page.getByRole('list', { name: 'Asset types, largest first' });
  const rows = list.getByRole('button');
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toHaveAccessibleName('Unclassified 636 29%');
  await expect(rows.nth(1)).toHaveAccessibleName('Cloud Security Group 516 23%');
  await expect(rows.nth(7)).toHaveAccessibleName(/^Storage Bucket 44/);

  const more = page.getByRole('button', { name: '+29 more' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(rows).toHaveCount(TYPES.length);
  // A one-asset type out of 2,204 is a real asset, never "0.0%".
  await expect(rows.last()).toHaveAccessibleName('Tail type 24 1 <0.1%');
});

test('Last seen is an age, with the exact time in its tip', async ({ page }) => {
  await setup(page);
  await page.goto('/#assets');
  const cell = page.locator('[data-panel-id="assets-list"] tbody tr').first().getByText('8h ago', { exact: true });
  await expect(cell).toBeVisible();
  await expect(cell).toHaveAttribute('title', /2026/);
});
