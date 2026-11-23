import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { FIXED_NOW, installBaselineWorld } from './page-fixtures';

// The owner's screenshot at 2000px wide: a narrow left column, a list that
// stopped near 1010px, the right half of the screen empty, and Service details
// below the fold. These measure the page rather than its class names, so they
// hold for whichever layout is chosen.

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const nowS = FIXED_NOW.getTime() / 1000;
const DAY = 86400;
const incident = (key: string, severity: string) => ({ key, category: key, severity, count: 2, message: `${key} incident`, first_detected_at: nowS - 3 * DAY });

async function busyWorld(page: Page, extra = 0) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installBaselineWorld(page);
  await page.route('**/api/hub/health*', (r) => json(r, [
    { name: 'DNS', status: 'warn', statusLabel: 'warning', meta: '2 stopped · 16/18 up', availability: 'ok' },
    { name: 'DHCP', status: 'crit', statusLabel: 'critical', meta: '8 stopped · 10/18 up', availability: 'ok' },
    { name: 'Security', status: 'ok', statusLabel: 'healthy', meta: '4/4 up', availability: 'ok' },
  ]));
  await page.route('**/api/incidents', (r) => json(r, {
    incidents: [incident('capacity', 'crit'), incident('dns-ttl-anomaly', 'warn'), incident('dnssec', 'warn'), incident('stale-leases', 'warn'), ...Array.from({ length: extra }, (_, i) => incident(`extra-${i}`, 'warn'))],
    signals: [],
  }));
  await page.goto('/#overview');
  await expect(page.locator('[data-problem]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Service details' })).toBeVisible();
}

// How far right the content in the first screen reaches, against the room it has.
const firstScreenReach = (page: Page) => page.evaluate(() => {
  const wrap = document.querySelector('.ov-look.br')!.parentElement!;
  const pad = parseFloat(getComputedStyle(wrap).paddingRight);
  const available = wrap.getBoundingClientRect().right - pad;
  const items = [...document.querySelectorAll('[data-problem], .br-fact, .ov-kpis')];
  const seen = items.map((el) => el.getBoundingClientRect()).filter((b) => b.width > 0 && b.top < innerHeight);
  return { available, reach: Math.max(...seen.map((b) => b.right)) };
});

for (const width of [1440, 2000]) {
  test(`Overview uses the available width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await busyWorld(page);
    const { available, reach } = await firstScreenReach(page);
    expect(reach).toBeGreaterThanOrEqual(available - 24);
  });
}

test('Service details starts within the first screen at 2000x900', async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 900 });
  await busyWorld(page);
  const box = await page.getByRole('heading', { name: 'Service details' }).boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
});

test('a long list still leaves Service details on the first screen at 2000x900', async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 900 });
  await busyWorld(page, 6);
  await expect(page.locator('[data-problem]')).toHaveCount(14);
  const box = await page.getByRole('heading', { name: 'Service details' }).boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
});

test('the page does not scroll sideways at the width where the wide layout starts', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await busyWorld(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('nothing is lost and the page does not scroll sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await busyWorld(page);
  for (const name of ['Since yesterday', 'Items requiring attention', 'Current status', 'Service details']) {
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
