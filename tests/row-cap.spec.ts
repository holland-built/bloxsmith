import { test, expect } from '@playwright/test';

// The dense subnet DataTable no longer caps at maxRows=50 with a "Show all"
// expander. It now uses scrollBody: ALL rows render inside a bounded
// `.dt-scroll` region (max-height, overflow-y:auto) with a sticky header, and a
// passive `.dt-count` "{N} rows" footer (no button). The subnet table's
// problemsOnly default is ON (util>70), so we mock 60 subnets all with util
// 71..99 (none 100, so collapseIdentical never fires) — all 60 survive the
// problems filter and, being < the 300-row render window, all render at once.

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

test('subnet table renders every row in a bounded scroll region (no 50 cap, no Show all)', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // The subnet table is the first scrollBody DataTable on the page.
  const scroll = page.locator('.dt-scroll').first();
  await expect(scroll).toBeVisible();

  // It is a real scroll region: overflow-y:auto and a bounded height whose
  // content overflows (no maxRows cap — all 60 rows are in the DOM).
  await expect(scroll).toHaveCSS('overflow-y', 'auto');
  const rows = scroll.locator('tbody tr');
  await expect.poll(() => rows.count()).toBe(N);

  const bounded = await scroll.evaluate(el => el.scrollHeight > el.clientHeight + 4);
  expect(bounded).toBe(true); // content taller than the bounded viewport

  // Passive footer shows "{N} rows"; the old "Show all" expander is gone.
  await expect(page.locator('.dt-count').first()).toHaveText(N + ' rows');
  await expect(page.locator('.dt-more-btn')).toHaveCount(0);

  // The last row starts below the fold, and scrolling the container brings it
  // into the visible viewport — every row is reachable.
  const belowFoldFirst = await scroll.evaluate(el => {
    const r = el.querySelectorAll('tbody tr');
    const last = r[r.length - 1].getBoundingClientRect();
    return last.top > el.getBoundingClientRect().bottom;
  });
  expect(belowFoldFirst).toBe(true);

  const revealed = await scroll.evaluate(el => {
    el.scrollTop = el.scrollHeight;
    const r = el.querySelectorAll('tbody tr');
    const last = r[r.length - 1].getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { moved: el.scrollTop > 0, inView: last.top >= box.top - 1 && last.top <= box.bottom + 1 };
  });
  expect(revealed.moved).toBe(true);
  expect(revealed.inView).toBe(true);
});

test('j-cursor still advances in the scroll-body subnet table', async ({ page }) => {
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
