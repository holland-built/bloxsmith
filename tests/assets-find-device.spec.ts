import { test, expect } from './fixtures';
import { ASSETS_BY_ADDRESS, ASSETS_BY_ADDRESS_NONE, installFixtures } from './page-fixtures';

// Find a device by IP or MAC (2026-11). The Assets search used to match names
// only. An address now goes to Infoblox's asset search, which sees only devices
// synced in the last 7 days, so the page says that in plain words, and shows
// which sources saw each device.

test('an IP in the search box finds the device and says which sources saw it', async ({ page }) => {
  const fx = await installFixtures(page, 'assets');
  const asked: string[] = [];
  await page.route('**/api/csp/assets?*', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q');
    if (q) asked.push(q);
    return q === '172.17.0.4'
      ? r.fulfill({ json: ASSETS_BY_ADDRESS })
      : r.fallback();
  });
  await page.goto('/#assets');

  const box = page.getByRole('textbox', { name: 'Search assets by name, IP or MAC address' });
  await expect(box).toHaveAttribute('placeholder', 'Name, IP or MAC');
  await box.fill('172.17.0.4');
  await box.press('Enter');

  const list = page.locator('[data-panel-id="assets-list"]');
  await expect(list.getByRole('columnheader', { name: /Seen by/ })).toBeVisible();
  await expect(list.getByRole('row', { name: /baseline-gm-1/ })).toContainText('DHCP Logs, NIOS Grid');
  await expect(list).toContainText('Devices with 172.17.0.4 seen in the last 7 days');
  expect(asked).toContain('172.17.0.4');
  expect(fx.unmatched()).toEqual([]);
});

test('an address nobody has seen says "not seen in the last 7 days", not "no assets"', async ({ page }) => {
  await installFixtures(page, 'assets');
  await page.route('**/api/csp/assets?*', (r) =>
    new URL(r.request().url()).searchParams.get('q') === '10.9.9.9' ? r.fulfill({ json: ASSETS_BY_ADDRESS_NONE }) : r.fallback());
  await page.goto('/#assets');

  const box = page.getByRole('textbox', { name: 'Search assets by name, IP or MAC address' });
  await box.fill('10.9.9.9');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  await expect(page.locator('[data-panel-id="assets-list"]')).toContainText('No device with that address was seen in the last 7 days');
});
