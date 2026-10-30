import { test, expect } from './fixtures';
import { installBaselineWorld, dataPayload } from './page-fixtures';

// UI/UX review 2026-10-30: panels whose numbers disagreed with themselves.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('Daily: a subnet that reports a total of 0 is not ranked as the top capacity risk', async ({ page }) => {
  const base = dataPayload();
  await page.route('**/api/data*', (route) => route.fulfill({
    json: {
      ...base,
      subnets: [
        { id: 'empty', addr: 'fd10:1900::', cidr: 24, total: 0, used: 0, util: 0, site: '' },
        { id: 'real', addr: '10.9.9.0', cidr: 24, total: 256, used: 200, util: 78, site: '' },
      ],
    },
  }));
  await page.goto('/#daily');
  const panel = page.locator('h2', { hasText: 'Top Capacity Risks' }).first().locator('xpath=ancestor::div[contains(@class,"bg-card")]');
  await expect(panel.getByText('10.9.9.0')).toBeVisible({ timeout: 20_000 });
  const cells = await panel.locator('[role="row"], tr').allInnerTexts();
  const body = cells.filter((t) => /10\.9\.9\.0|fd10:1900::/.test(t));
  expect(body[0]).toContain('10.9.9.0');
});

test('Network: IPAM Spaces bars are sized by addresses used, like the numbers beside them', async ({ page }) => {
  await page.route('**/api/csp/ipam-util', (route) => route.fulfill({
    json: {
      status: 'ok', count: 2, rows: [
        { id: 'big', label: 'big-space', total: 100000, used: 2000 },
        { id: 'small', label: 'small-space', total: 1000, used: 500 },
      ],
    },
  }));
  await page.goto('/#network');
  const panel = page.locator('[data-panel-id="network-ipam-spaces"]');
  await expect(panel.getByText('big-space')).toBeVisible({ timeout: 20_000 });
  const width = (label: string) => panel.locator('div.flex.items-center', { hasText: label })
    .locator('div.h-full').evaluate((el) => el.getBoundingClientRect().width);
  expect(await width('big-space')).toBeGreaterThan(await width('small-space'));
});
