import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Get an address took 5 clicks every time: space, subnet, Preview, Allocate,
// plus finding the page. Most people take addresses from the same subnet again,
// so the form now starts on the last space and subnet that an address was
// actually handed out from, for the same tenant, if both still exist.

function json(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const LAST = (tenant: string, subnet = 'ipam/subnet/s2') =>
  JSON.stringify({ [tenant]: { space: 'ipam/ip_space/b', subnet } });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/ipam/spaces*', (route) => json(route, { spaces: [
    { id: 'ipam/ip_space/a', name: 'Amsterdam Lab' },
    { id: 'ipam/ip_space/b', name: 'Berlin Office' },
  ] }));
  await page.route('**/api/ipam/blocks*', (route) => json(route, { blocks: [] }));
  await page.route('**/api/ipam/subnets*', (route) => json(route, { subnets: [
    { id: 'ipam/subnet/s1', address: '10.2.0.0', cidr: 24, name: 'office-a' },
    { id: 'ipam/subnet/s2', address: '10.2.1.0', cidr: 24, name: 'office-b' },
  ] }));
});

async function tenantId(page: import('@playwright/test').Page) {
  return page.evaluate(async () => (await (await fetch('/api/vault/status')).json()).active as string);
}

test('the form starts on the last space and subnet an address came from', async ({ page }) => {
  await page.goto('/#overview');
  const t = await tenantId(page);
  await page.evaluate((v) => localStorage.setItem('bloxsmith.allocate.last', v), LAST(t));
  await page.goto('/#selfservice');
  const panel = page.locator('[data-panel-id="selfservice-allocate"]');
  await expect(panel.getByRole('combobox', { name: 'IP Space' })).toHaveValue('ipam/ip_space/b');
  await expect(panel.getByRole('combobox', { name: 'Subnet' })).toHaveValue('ipam/subnet/s2');
  await expect(panel.getByRole('button', { name: 'Preview' })).toBeEnabled();
});

test('a remembered subnet that no longer exists is not picked', async ({ page }) => {
  await page.goto('/#overview');
  const t = await tenantId(page);
  await page.evaluate((v) => localStorage.setItem('bloxsmith.allocate.last', v), LAST(t, 'ipam/subnet/gone'));
  await page.goto('/#selfservice');
  const panel = page.locator('[data-panel-id="selfservice-allocate"]');
  await expect(panel.getByRole('combobox', { name: 'IP Space' })).toHaveValue('ipam/ip_space/b');
  await page.waitForTimeout(500);
  await expect(panel.getByRole('combobox', { name: 'Subnet' })).toHaveValue('');
});

test('another tenant\'s last pick is not used', async ({ page }) => {
  await page.goto('/#overview');
  await page.evaluate((v) => localStorage.setItem('bloxsmith.allocate.last', v), LAST('some-other-tenant'));
  await page.goto('/#selfservice');
  await page.waitForTimeout(800);
  await expect(page.locator('[data-panel-id="selfservice-allocate"]').getByRole('combobox', { name: 'IP Space' })).toHaveValue('');
});

test('a successful Allocate is what gets remembered, not a pick', async ({ page }) => {
  await page.route('**/api/selfservice/allocate*', (route) => json(route, [{ address: '10.2.1.5' }]));
  await page.goto('/#selfservice');
  const panel = page.locator('[data-panel-id="selfservice-allocate"]');
  await panel.getByRole('combobox', { name: 'IP Space' }).selectOption({ label: 'Berlin Office' });
  await panel.getByRole('combobox', { name: 'Subnet' }).selectOption({ label: '10.2.1.0/24 — office-b' });
  expect(await page.evaluate(() => localStorage.getItem('bloxsmith.allocate.last'))).toBeNull();
  await panel.getByRole('button', { name: 'Preview' }).click();
  await panel.getByRole('button', { name: 'Allocate', exact: true }).click();
  await expect(panel.getByText('Address allocated.')).toBeVisible();
  const saved = JSON.parse((await page.evaluate(() => localStorage.getItem('bloxsmith.allocate.last'))) || '{}');
  expect(saved[await tenantId(page)]).toEqual({ space: 'ipam/ip_space/b', subnet: 'ipam/subnet/s2' });
});
