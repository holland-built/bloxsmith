import { test, expect } from './fixtures';
import { installFixtures, installBaselineWorld, ALL_PAGES, FIXED_NOW } from './page-fixtures';

// The owner's pick 3 (2026-11-24): every page title is one middle size, and
// every page that shows live data says when that data last arrived, at its top
// right. Pages with no live data (forms and tools) carry no Updated label.
//
// Titles had drifted to three sizes (26px Overview, 20px some, 14px the rest),
// and Updated sat on only five of the twelve data pages.
test.use({ timezoneId: 'UTC', locale: 'en-US' });

const DATA_PAGES = [
  'overview', 'daily', 'best-practices', 'value', 'network', 'dns', 'security',
  'infra', 'assets', 'incidents', 'audit', 'changes',
];
const NO_DATA_PAGES = [
  'automate', 'provision', 'selfservice', 'editor', 'drift', 'lists', 'made', 'demo', 'ai', 'chart',
];

// page-fixtures.ts has no answer for these two pages' reads, so in the
// baseline world they honestly say "unavailable". Serve a minimal one.
async function feedsWithoutFixtures(page) {
  await page.route('**/api/best-practices', (r) => r.fulfill({ json: { checks: [] } }));
  await page.route('**/api/csp/value-security', (r) => r.fulfill({ json: {} }));
}

async function open(page, id: string) {
  await page.goto(`/#${id}`);
  const h1 = page.locator('main h1:not(.sr-only)').first();
  await h1.waitFor({ timeout: 20000 });
  return h1;
}

for (const id of [...DATA_PAGES, ...NO_DATA_PAGES]) {
  test(`"${id}": the title is the one page-title size`, async ({ page }) => {
    await installBaselineWorld(page);
    const h1 = await open(page, id);
    const size = await h1.evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe('20px');
  });
}

for (const id of DATA_PAGES) {
  test(`"${id}": Updated sits at the top right with the time its data arrived`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await installBaselineWorld(page);
    await feedsWithoutFixtures(page);
    const h1 = await open(page, id);
    const pill = page.locator('main [data-updated]');
    await expect(pill).toHaveCount(1);
    // FIXED_NOW is 12:00 UTC; the fixtures answer at once, so the read lands then.
    await expect(pill).toHaveText(/Updated 12:00/, { timeout: 15000 });
    const p = (await pill.boundingBox())!;
    const t = (await h1.boundingBox())!;
    const main = (await page.locator('main').boundingBox())!;
    // Top: level with the title. Right: in the right-hand part of the page.
    expect(Math.abs(p.y + p.height / 2 - (t.y + t.height / 2))).toBeLessThan(Math.max(t.height, 40));
    expect(p.x + p.width).toBeGreaterThan(main.x + main.width * 0.6);
  });
}

for (const id of NO_DATA_PAGES) {
  test(`"${id}": no Updated label on a page without live data`, async ({ page }) => {
    await installBaselineWorld(page);
    await open(page, id);
    await page.waitForTimeout(500);
    await expect(page.locator('main [data-updated]')).toHaveCount(0);
  });
}

// The time is when the page's own read arrived, never the clock on the wall:
// with every later read refused, ten minutes passing must not move it.
for (const id of DATA_PAGES) {
  test(`"${id}": Updated does not move with the clock when no read arrives`, async ({ page }) => {
    await page.clock.install({ time: FIXED_NOW });
    await installFixtures(page, ALL_PAGES);
    await feedsWithoutFixtures(page);
    await open(page, id);
    const pill = page.locator('main [data-updated]');
    await expect(pill).toHaveText(/Updated 12:00/, { timeout: 15000 });
    await page.route('**/api/**', (r) => r.abort('failed'));
    await page.clock.runFor(10 * 60 * 1000);
    await expect(pill).not.toHaveText(/12:10/);
    await expect(pill).toContainText('12:00');
  });
}
