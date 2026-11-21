import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Value page: Scoreboard on screen, the Monthly report on paper. Every
// /api/ response is faked, so the numbers below are this file's own.
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const days = Array.from({ length: 30 }, (_, i) => ({
  day: `2026-10-${String(i + 1).padStart(2, '0')}`,
  value: i === 4 ? null : i === 9 ? 900 : 100,
}));
const security = { status: 'ok', metrics: {
  blocked: { status: 'ok', value: 3700, covered: true, previous: null, previous_status: 'partial', window_range: ['2026-10-01', '2026-10-30'] },
  zero_day: { status: 'ok', value: 18 },
  sus_to_mal: { status: 'error', value: null },
} };
const platform = { status: 'ok', metrics: {
  queries: { status: 'ok', unit: 'queries', value: 25917716 },
  cache_hit: { status: 'error', unit: 'percent', value: null },
  uptime: { status: 'ok', unit: 'percent', value: 99.5, hosts: [{ host_name: 'dns-1', value: 99.5 }] },
  dhcp_assigned: { status: 'unavailable', unit: 'addresses', value: null, reason: 'Not available: test reason.' },
  roaming: { status: 'empty', unit: 'devices', value: null },
} };

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/csp/value-security', (r) => r.fulfill(json(security)));
  await page.route('**/api/csp/value-platform', (r) => r.fulfill(json(platform)));
  await page.route('**/api/csp/value-daily', (r) => r.fulfill(json({ status: 'ok', days })));
  await page.route('**/api/desk/runs', (r) => r.fulfill(json({ tenant: 't', runs: [] })));
  await page.goto('/#value');
  await expect(page.locator('[data-stat="blocked"]').first()).toContainText('3,700');
});

test('opens on Scoreboard and says what the blocked number counts', async ({ page }) => {
  const blocked = page.locator('[data-card-grid] [data-stat="blocked"]');
  await expect(blocked).toContainText('DNS lookups blocked');
  await expect(blocked).toContainText('policy and content rules');
  await expect(blocked).not.toContainText(/threats blocked/i);
  await expect(page.locator('[data-layout-arrange]')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Preview looks' })).toHaveCount(0);
});

test('an unread number is a word, never a figure', async ({ page }) => {
  for (const key of ['sus_to_mal', 'cache_hit', 'dhcp_assigned', 'roaming']) {
    await expect(page.locator(`[data-card-grid] [data-stat="${key}"] .vl-num`)).not.toHaveText(/\d/);
  }
  await page.getByText('Each server (1)').click();
  await expect(page.getByText('dns-1:')).toBeVisible();
});

test('the day chart reads by keyboard and by tap', async ({ page }) => {
  const chart = page.getByRole('slider', { name: /lookups blocked each day/i });
  const readout = page.locator('[data-chart-readout]');
  await expect(readout).toContainText('Peak day. Oct 10: 900 blocked');
  await chart.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(readout).toContainText('Oct 9: 100 blocked');
  await expect(chart).toHaveAttribute('aria-valuetext', /Oct 9: 100 blocked/);
  await page.keyboard.press('Home');
  await expect(readout).toContainText('Oct 1:');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(readout).toContainText('Oct 5: no data');
  const box = (await chart.boundingBox())!;
  await page.mouse.click(box.x + box.width * (29.5 / 30), box.y + box.height / 2);
  await expect(readout).toContainText('Oct 30: 100 blocked, may be incomplete');
});

test('Print report prints only the report', async ({ page }) => {
  await page.evaluate(() => { (window as any).__printed = 0; window.print = () => { (window as any).__printed++; }; });
  await expect(page.locator('[data-value-report]')).toBeHidden();
  await page.getByRole('button', { name: 'Print report' }).click();
  expect(await page.evaluate(() => (window as any).__printed)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('[data-value-report]')).toBeVisible();
  await expect(page.locator('[data-card-grid]')).toBeHidden();
  const report = page.locator('[data-value-report]');
  await expect(report.locator('[data-stat="cache_hit"] td')).toHaveText('Not checked');
  await expect(report.locator('[data-report-account]')).toHaveText('Baseline Tenant');
  await expect(report).not.toContainText('baseline-tenant');
  await expect(report.locator('[data-report-gaps]')).toHaveText('No data for 1 day. Dashed bars are not values.');
  await expect(report.locator('[data-stat="dhcp_assigned"]')).toContainText('Not available');
  await expect(report.locator('[data-stat="dhcp_assigned"]')).not.toContainText('test reason');
});
