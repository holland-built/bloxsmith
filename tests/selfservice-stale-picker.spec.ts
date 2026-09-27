import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// useApi used to keep handing out the previous url's data while a new url
// loaded. Self-Service's Block picker, enabled whenever a space is chosen,
// then offered one space's blocks under another. Data now belongs to the url
// it was answered for, so nothing from the old space is offered meanwhile.

function json(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/ipam/spaces*', (route) => json(route, { spaces: [
    { id: 'ipam/ip_space/a', name: 'Amsterdam Lab' },
    { id: 'ipam/ip_space/b', name: 'Berlin Office' },
  ] }));
  await page.route('**/api/ipam/blocks*', async (route) => {
    const space = new URL(route.request().url()).searchParams.get('space');
    const isA = space === 'ipam/ip_space/a';
    if (!isA) await new Promise((r) => setTimeout(r, 2500));
    return json(route, { blocks: [{ id: isA ? 'ipam/address_block/a1' : 'ipam/address_block/b1', address: isA ? '10.1.0.0/16' : '10.2.0.0/16' }] });
  });
});

test('while the new space\'s blocks load, the Block picker offers none of the old space\'s', async ({ page }) => {
  await page.goto('/#selfservice');
  const panel = page.locator('[data-panel-id="selfservice-allocate"]');
  const space = panel.getByLabel('IP Space');
  const block = panel.getByLabel('Block');
  await space.selectOption({ label: 'Amsterdam Lab' });
  await expect(block.locator('option', { hasText: '10.1.0.0/16' })).toHaveCount(1);

  await space.selectOption({ label: 'Berlin Office' });
  await page.waitForTimeout(800); // B is still loading
  // One reading, not a retrying expect: a retry would simply wait for B's
  // answer to replace the list and pass on the old code too.
  expect(await block.locator('option').allTextContents()).not.toContain('10.1.0.0/16');

  await expect(block.locator('option', { hasText: '10.2.0.0/16' })).toHaveCount(1, { timeout: 5000 });
});
