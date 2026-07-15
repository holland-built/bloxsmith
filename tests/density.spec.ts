import { test, expect } from '@playwright/test';

// Density toggle: compact (--row-h:28px) <-> comfortable (--row-h:32px).
// Persisted under localStorage['bx.density']; the boot <script> re-applies it to
// html[data-density] before React mounts, so it survives a reload.

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 60, site: 'DR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

const CELL = 'div[tabindex="0"]:has(tr.clickable) tbody td';

test('density toggle grows row height and persists across reload', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network');

  const td = page.locator(CELL).first();
  await expect(td).toBeVisible();
  const compactH = await td.evaluate(el => el.getBoundingClientRect().height);
  expect(compactH, 'compact row ~28px').toBeLessThan(31);

  // Flip to comfortable. The density toggle lives two levels deep in the topbar
  // overflow: ⋯ (MoreMenu) -> gear (ViewOptions) -> toggle. Both panels are
  // display:none when closed, so open them in order (same as theme.spec).
  await page.getByRole('button', { name: /^More tools/ }).click();
  await page.getByRole('button', { name: 'View options' }).click();
  const densityToggle = page.getByRole('button', { name: 'Toggle row density' });
  await expect(densityToggle).toBeVisible();
  await densityToggle.click();
  const comfyH = await td.evaluate(el => el.getBoundingClientRect().height);
  expect(comfyH, 'comfortable row taller than compact').toBeGreaterThan(compactH);

  // Persisted as JSON string.
  const stored = await page.evaluate(() => localStorage.getItem('bx.density'));
  expect(stored).toBe(JSON.stringify('comfortable'));

  // Reload -> density restored from localStorage (boot script), rows still tall.
  await page.reload();
  const td2 = page.locator(CELL).first();
  await expect(td2).toBeVisible();
  const afterReloadH = await td2.evaluate(el => el.getBoundingClientRect().height);
  expect(afterReloadH, 'density persisted after reload').toBeGreaterThan(compactH);
});
