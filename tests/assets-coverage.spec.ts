import { test, expect } from './fixtures';
import { ASSET_COVERAGE, installFixtures } from './page-fixtures';

// Coverage gaps (2026-11): devices seen on the network that a tool meant to
// know every device never reported. One tile per such tool the tenant has;
// a tile is a link that filters the list to exactly the devices it counted,
// and a count the server could not trust reads "couldn't count", never a number.

const panel = (page: import('@playwright/test').Page) => page.locator('[data-panel-id="assets-coverage"]');

test('a gap tile shows its count and filters the list to those devices', async ({ page }) => {
  const fx = await installFixtures(page, 'assets');
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/csp/assets?')) asked.push(r.url()); });
  await page.goto('/#assets');

  const tile = panel(page).getByRole('link', { name: /^Seen on the network, not by the Infoblox agent/ });
  await expect(tile).toContainText('1');
  await expect(tile).toContainText('Infoblox Endpoint · seen by DHCP logs or your Infoblox servers');
  await tile.click();

  await expect(page).toHaveURL(/#assets\?gap=Infoblox(\+|%20)Endpoint$/);
  await expect.poll(() => asked.some((u) => new URL(u).searchParams.get('gap') === 'Infoblox Endpoint')).toBe(true);
  const list = page.locator('[data-panel-id="assets-list"]');
  await expect(list).toContainText('Showing devices seen on the network but not in Infoblox Endpoint');
  await list.getByRole('button', { name: 'Show all devices' }).click();
  await expect(page).toHaveURL(/#assets$/);
  expect(fx.unmatched()).toEqual([]);
  expect(fx.neverCalled()).toEqual([]);
});

test('a count the server could not trust says "couldn\'t count"', async ({ page }) => {
  await installFixtures(page, 'assets');
  await page.route('**/api/csp/asset-coverage', (r) => r.fulfill({ json: {
    ...ASSET_COVERAGE, total: null,
    gaps: [{ source: 'CrowdStrike Falcon', role: 'security agent', count: null }],
    reason: "couldn't count: there were more combinations of sources than this app reads at once",
  } }));
  await page.goto('/#assets');

  const tile = panel(page).getByRole('link', { name: /^Seen on the network, not by a security agent/ });
  await expect(tile).toContainText('CrowdStrike Falcon');
  await expect(tile).toContainText("couldn't count");
  await expect(tile).toContainText('security agent');
  await expect(tile).not.toContainText('0');
});

test('a tenant with nothing to compare says why there are no tiles', async ({ page }) => {
  await installFixtures(page, 'assets');
  await page.route('**/api/csp/asset-coverage', (r) => r.fulfill({ json: { ...ASSET_COVERAGE, gaps: [] } }));
  await page.goto('/#assets');
  await expect(panel(page)).toContainText('Nothing to compare');
});

test('a coverage read that failed says unavailable, not zero', async ({ page }) => {
  await installFixtures(page, 'assets');
  await page.route('**/api/csp/asset-coverage', (r) => r.fulfill({ json: {
    availability: 'error', reason: 'the asset source query failed in Infoblox', total: null, network: [], gaps: [],
  } }));
  await page.goto('/#assets');
  await expect(panel(page)).toContainText('Coverage gaps unavailable');
  await expect(panel(page)).toContainText('the asset source query failed in Infoblox');
});
