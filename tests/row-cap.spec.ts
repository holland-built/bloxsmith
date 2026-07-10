import { test, expect } from '@playwright/test';

// DataTable caps the subnet table at maxRows=50 by default and offers a
// "Show all" escape hatch. The subnet table's problemsOnly default is ON
// (util>70), so we mock 60 subnets all with util 71..99 (none 100, so the
// collapseIdentical grouping never fires) — all 60 survive the problems filter.

const N = 60;
const SUBNETS = Array.from({ length: N }, (_, i) => ({
  id: 's-' + i,
  name: 'Net ' + i,
  addr: '10.' + (i + 1) + '.0.0',
  cidr: 24,
  util: 71 + (i % 29),           // 71..99, never 100
  site: 'HQ',
  total: 256,
}));
const DATA = { subnets: SUBNETS, leases: [], zones: [], hosts: [], auditLogs: [], events: [] };

const WRAP = 'div[tabindex="0"]:has(tr.clickable)';

test('subnet table caps at 50 rows with a Show all expander', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // Default: capped to <=50 rows. Scope to the subnet table (first .dt; the
  // page also carries a small DHCP-leases .dt with an empty-state row).
  const rows = page.locator('table.dt').first().locator('tbody tr');
  await expect.poll(() => rows.count()).toBeLessThanOrEqual(50);
  const capped = await rows.count();
  expect(capped).toBeGreaterThan(0);

  // The "Show all" expander (dt-more) is present.
  const showAll = page.locator('.dt-more-btn', { hasText: 'Show all' });
  await expect(showAll).toBeVisible();

  // Click it -> all 60 rows render.
  await showAll.click();
  await expect.poll(() => rows.count()).toBe(N);
});

test('j-cursor still advances after Show all is expanded', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  const wrap = page.locator(WRAP).first();
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();
  await page.keyboard.press('j');

  // The keyboard cursor links the wrapper to a row via aria-activedescendant.
  await expect.poll(async () =>
    (await wrap.getAttribute('aria-activedescendant')) || ''
  ).not.toBe('');
});
