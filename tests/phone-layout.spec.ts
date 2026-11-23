import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { dataPayload, installBaselineWorld, installFixtures } from './page-fixtures';

// What a phone must still be able to do: reach every table column by swiping,
// keep the page itself from moving sideways, and read rows, panel headers,
// chart numbers and small row actions without anything landing on top of
// something else. Each check here failed on the code before this change.

const PHONES = [320, 390];
const TABLE_PAGES = ['network', 'dns', 'incidents', 'security', 'audit', 'daily', 'assets', 'infra'];

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

for (const width of PHONES) {
  for (const tab of TABLE_PAGES) {
    test(`${tab} at ${width}px: every column can be reached and the page stays put`, async ({ page }) => {
      await installBaselineWorld(page);
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/#${tab}`);
      await expect(page.locator('main table').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(300);

      const problems = await page.$$eval('main table', (tables) =>
        tables.flatMap((t) => {
          const box = t.parentElement as HTMLElement;
          const out: string[] = [];
          for (const th of t.querySelectorAll('thead th')) {
            if (getComputedStyle(th).display === 'none') out.push(`hidden column ${th.textContent}`);
          }
          if (box.scrollWidth > box.clientWidth + 1 && getComputedStyle(box).overflowX !== 'auto') {
            out.push(`table is ${box.scrollWidth}px in a ${box.clientWidth}px box that cannot swipe`);
          }
          if (box.scrollWidth > box.clientWidth + 1 && box.getAttribute('tabindex') !== '0') {
            out.push('a table wider than its box cannot be scrolled from the keyboard');
          }
          for (const cell of t.querySelectorAll('thead th')) {
            const el = cell as HTMLElement;
            if (el.scrollWidth > el.clientWidth + 1) out.push(`heading cut: ${el.textContent}`);
          }
          return out;
        }),
      );
      expect(problems).toEqual([]);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  }

  test(`best practices at ${width}px: an opened row with long values stays on the page`, async ({ page }) => {
    const long = 'a-very-long-host-name-with-no-spaces.datacentre.example.internal';
    const checks = Array.from({ length: 7 }, (_, i) => ({
      id: `check-${i}`, severity: 'high', status: 'problem', title: `Problem number ${i}`, why: 'Why it matters.',
      items: [{ name: long, detail: `${long} is reporting an error state` }],
    }));
    await page.route('**/api/best-practices', (r) => r.fulfill(json({ checks })));
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/#best-practices');
    const rows = page.getByRole('list', { name: 'Best practice checks' }).locator(':scope > li');
    await expect(rows).toHaveCount(7);
    for (let i = 0; i < 7; i++) await rows.nth(i).locator('summary').click();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const off = await page.$$eval('.bp-items li > *', (els) =>
      els.filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5).length);
    expect(off).toBe(0);
  });

  test(`dns at ${width}px: the zone panel's controls stay inside the card`, async ({ page }) => {
    await installBaselineWorld(page);
    const zone = (id: string, view: string) => ({ id, fqdn: 'lab.example.', view, records: 1, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false });
    await page.route('**/api/data*', (r) => r.fulfill(json({ ...dataPayload(), zones: [zone('a', 'inside'), zone('b', 'outside')] })));
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/#dns');
    const card = page.locator('[data-panel-id="dns-zones"]');
    const compare = card.getByRole('button', { name: 'Compare views' });
    await expect(compare).toBeVisible({ timeout: 20_000 });
    const c = (await card.boundingBox())!;
    for (const el of [compare, card.getByLabel('Filter zones')]) {
      const b = (await el.boundingBox())!;
      expect(b.x, 'left edge inside the card').toBeGreaterThanOrEqual(c.x);
      expect(b.x + b.width, 'right edge inside the card').toBeLessThanOrEqual(c.x + c.width);
    }
    // The panel's own buttons stay level with its title.
    const title = (await card.locator('h2').first().boundingBox())!;
    const menu = (await card.getByRole('button', { name: /menu|options|panel/i }).first().boundingBox())!;
    expect(Math.abs(menu.y + menu.height / 2 - (title.y + title.height / 2))).toBeLessThan(16);
  });

  test(`build a chart at ${width}px: bar numbers do not overlap`, async ({ page }) => {
    await installFixtures(page, 'chart');
    const rows = Array.from({ length: 10 }, (_, i) => ({
      'DnsActivityV1.device_name': `ws-${i}`, 'DnsActivityV1.device_ip': `10.0.0.${i}`, 'DnsActivityV1.total_query_count': String(48211000 - i * 1000),
    }));
    await page.route('**/api/chart?*', (r) => r.fulfill(json({ status: 'ok', endpoint: '/api/cubejs/v1/query', query: {}, rows })));
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/#chart');
    const labels = page.locator('[data-chart-result] .recharts-label-list text');
    await expect(labels).toHaveCount(10, { timeout: 20_000 });
    const boxes = await labels.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom };
    }));
    const hits = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b));
    expect(hits).toEqual([]);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
}

test('automate on a desktop: the form sits beside the job list', async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#automate');
  const list = (await page.getByRole('navigation', { name: 'Jobs to automate' }).boundingBox())!;
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job).toBeVisible();
  const form = (await job.boundingBox())!;
  expect(form.x).toBeGreaterThanOrEqual(list.x + list.width);
  expect(Math.abs(form.y - list.y)).toBeLessThan(4);
});

test('the phone logo and the setup close button keep their size', async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/#overview');
  await expect(page.locator('main h1')).toHaveText('Overview', { timeout: 20_000 });
  const logo = await page.locator('.frame-phone-logo').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { flexShrink: getComputedStyle(el).flexShrink, w: r.width, h: r.height };
  });
  expect(logo.flexShrink).toBe('0');
  expect(logo.w).toBeCloseTo(logo.h, 0);

  await page.evaluate(() => window.dispatchEvent(new Event('bx:open-setup')));
  const close = page.getByRole('dialog', { name: 'Finish setting up' }).getByRole('button', { name: 'Close' });
  const b = (await close.boundingBox())!;
  expect(b.width).toBeGreaterThanOrEqual(32);
  expect(b.height).toBeGreaterThanOrEqual(32);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

  for (const tab of ['security', 'incidents']) {
    test(`${tab}: row checkboxes are at least 24px`, async ({ page }) => {
      await installBaselineWorld(page);
      await page.goto(`/#${tab}`);
      const box = page.locator('main table input[type="checkbox"]').first();
      await expect(box).toBeAttached({ timeout: 20_000 });
      const size = await box.evaluate((el) => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }));
      expect(size.w).toBeGreaterThanOrEqual(24);
      expect(size.h).toBeGreaterThanOrEqual(24);
    });
  }

  test('the Block and Reopen row actions are at least 24px tall', async ({ page }) => {
    await installBaselineWorld(page);
    await page.goto('/#security');
    await expect(page.locator('main table').first()).toBeVisible({ timeout: 20_000 });
    const heights = await page.evaluate(() => {
      const probe = (cls: string) => {
        const host = document.querySelector('main table td') ?? document.body;
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = 'x';
        host.appendChild(b);
        const h = b.getBoundingClientRect().height;
        b.remove();
        return h;
      };
      return { block: probe('sec-block'), quiet: probe('inc-quiet') };
    });
    expect(heights.block).toBeGreaterThanOrEqual(24);
    // Incidents.css loads with its own tab, so the Reopen style is read there.
    await page.goto('/#incidents');
    await expect(page.locator('main table').first()).toBeVisible({ timeout: 20_000 });
    const quiet = await page.evaluate(() => {
      const host = document.querySelector('main table td') ?? document.body;
      const b = document.createElement('button');
      b.className = 'inc-quiet';
      b.textContent = 'x';
      host.appendChild(b);
      const h = b.getBoundingClientRect().height;
      b.remove();
      return h;
    });
    expect(quiet).toBeGreaterThanOrEqual(24);
  });
});
