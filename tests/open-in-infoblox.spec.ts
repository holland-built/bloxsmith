import { test, expect } from '@playwright/test';
// The UI's own copy: scripts/e2e.sh installs ui/node_modules before any test runs.
import LZString from '../ui/node_modules/lz-string/libs/lz-string.js';
import CHART_OPTIONS from './chart-options.json';

// "Open in Infoblox": an asset chart links to the Infoblox Portal's Asset
// Inventory with the same filter, as a link under the chart and on each bar.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const T = 'AssetDetails_ch_agg.taxonomy_type_label';
const M = 'AssetDetails_ch_agg.assetsCount';
const filterOf = (href: string) =>
  JSON.parse(LZString.decompressFromEncodedURIComponent(new URL(href.replace('/#/', '/')).searchParams.get('advancedFilterValue')!)!);

test.beforeEach(async ({ page }) => {
  await page.route('**/api/chart/options', (r) => r.fulfill(json({ ...CHART_OPTIONS, portal: 'https://csp.infoblox.com' })));
  await page.route(/\/api\/chart\?/, (r) =>
    r.fulfill(json({ status: 'ok', endpoint: '/api/cubejs/v1/query', query: {}, rows: [{ [T]: 'Laptop', [M]: '1128' }, { [T]: 'Virtual Machine', [M]: '162' }] })),
  );
});

test('an asset chart links to the same assets in the Infoblox Portal', async ({ page }) => {
  await page.goto('/#chart?count=assets&split=atype&window=now&over=none&top=10');
  const all = page.getByRole('link', { name: 'Open these assets in Infoblox' });
  await expect(all).toHaveAttribute('href', 'https://csp.infoblox.com/#/workspace/assets/details/managed-assets?hideBreadcrumbs=true');
  await expect(all).toHaveAttribute('target', '_blank');
  await page.getByText(/Open one of the 2 bars in Infoblox/).click();
  const laptop = page.getByRole('link', { name: 'Laptop', exact: true });
  expect(filterOf((await laptop.getAttribute('href'))!)).toBe('asset.Type IN ["Laptop"]');
});

test('clicking a bar opens the portal on that bar', async ({ page, context }) => {
  await page.goto('/#chart?count=assets&split=atype&window=now&over=none&top=10');
  // Do not load the real portal; only the address it was sent to matters.
  await context.route('https://csp.infoblox.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  const popup = page.waitForEvent('popup');
  await page.locator('.recharts-bar-rectangle path').first().click();
  expect(filterOf((await popup).url())).toBe('asset.Type IN ["Laptop"]');
});

test('a DNS chart has no portal link', async ({ page }) => {
  await page.unroute(/\/api\/chart\?/);
  await page.route(/\/api\/chart\?/, (r) => r.fulfill(json({ status: 'ok', endpoint: '/api/cubejs/v1/query', query: {}, rows: [] })));
  await page.goto('/#chart?count=dns&split=device&window=7d&over=none&top=10');
  await expect(page.getByRole('heading', { name: /DNS queries/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open these assets in Infoblox' })).toHaveCount(0);
});
