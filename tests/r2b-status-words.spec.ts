import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 2, job r2b: the Status pages (Overview, Best practices,
// Daily) and the Infra page title. Each test names the finding it pins.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

async function fail(page: Page, glob: string) {
  await page.route(glob, (r) => r.fulfill({ status: 503, body: '' }));
}

test('A4: the subnet line in the attention list says the 90% count beside its own', async ({ page }) => {
  await page.goto('/#overview');
  const row = page.locator('.br-list li', { hasText: /subnets?/ }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('.br-title')).toContainText('90% full or more');
});

test('A8 R2-A5: a failed inventory read says "Information is unavailable" and "Not checked" in one way', async ({ page }) => {
  await fail(page, '**/api/data');
  await fail(page, '**/api/hub/**');
  await fail(page, '**/api/dns/**');
  await fail(page, '**/api/csp-audit**');
  await page.goto('/#overview');
  await expect(page.locator('[data-updated]').first()).toContainText('Information is unavailable');
  const text = await page.locator('main').innerText();
  expect(text).not.toContain('Inventory information is unavailable');
  expect(text).not.toContain('not checked: information unavailable');
  expect(text).not.toContain('Change log unavailable');
  expect(text).not.toMatch(/unavailable · hourly average/);
});

test('R2-A6: the briefing\'s middle section and its changes label fit what they hold', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.getByRole('heading', { level: 2, name: 'Last few hours', exact: true })).toBeVisible();
  await expect(page.locator('.br-fact .br-label', { hasText: /^Changes/ }).first()).not.toContainText('(');
});

test('R2-A7: on a phone each Overview service tile has its own row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/#overview');
  const tiles = page.getByRole('region', { name: 'Services at a glance' }).getByRole('button');
  await expect(tiles.first()).toBeVisible();
  const lefts = await tiles.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
});

test('R2-A8 A15: Overview action buttons use the plain secondary look, not the picked tint', async ({ page }) => {
  await page.goto('/#overview');
  const btn = page.locator('.br-list a.br-btn').first();
  await expect(btn).toBeVisible();
  const style = await btn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderTopLeftRadius, border: s.borderTopWidth };
  });
  expect(style.radius).toBe('10px');
  expect(style.border).toBe('1px');
});

test('R2-A1 R2-A2: Best practices link and tiles are in plain words', async ({ page }) => {
  await page.goto('/#best-practices');
  await expect(page.getByRole('link', { name: 'View servers' }).first()).toHaveAttribute('href', '#infra');
  const text = await page.locator('main').innerText();
  for (const word of ['Open Infra', 'not a pass', 'whole list read']) expect(text, word).not.toContain(word);
});

test('R2-A9: Daily says "90% full or more", as Overview does', async ({ page }) => {
  await page.goto('/#daily');
  await expect(page.getByText('90% full or more').first()).toBeVisible();
  expect(await page.locator('main').innerText()).not.toContain('≥');
});

test('A15: the Infra page title matches its menu name', async ({ page }) => {
  await page.goto('/#infra');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Infra');
});
