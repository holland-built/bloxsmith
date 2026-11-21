import { test, expect } from './fixtures';

// The Failed Lookups panel on the DNS tab (2026-11-20): the window picker
// sends the matching ?window= request, the pick is remembered, and a failed
// read says "not checked", never 0.

type Route = import('@playwright/test').Route;
const fulfillJson = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Invented numbers, a different total per window so a stale answer would show.
const TOTALS: Record<string, number> = { today: 120, yesterday: 340, 'this week': 5600, 'last 30 days': 78000 };
const body = (window: string) => ({
  status: 'ok',
  window,
  source: window === 'today' || window === 'yesterday' ? 'failure_records' : 'query_logs',
  total: TOTALS[window],
  codes: { nxdomain: TOTALS[window] - 20, servfail: 10, refused: 10, other: 0 },
  codes_status: 'ok',
  names: [{ name: 'missing.test.example.', count: 90 }],
  names_status: 'ok',
});

const panel = (page: import('@playwright/test').Page) => page.locator('[data-panel-id="dns-failed-lookups"]');

test('changing the window asks for that window and shows its numbers', async ({ page }) => {
  const asked: string[] = [];
  await page.route('**/api/csp/dns-failures*', (route) => {
    const w = new URL(route.request().url()).searchParams.get('window') ?? '';
    asked.push(w);
    return fulfillJson(route, body(w));
  });
  await page.goto('/#dns');
  const p = panel(page);
  await expect(p.locator('[data-failed-total] dd')).toHaveText('120');
  await expect(p.locator('[data-failed-source]')).toHaveText('From the last 3 days of failure records');
  expect(asked[0]).toBe('today');

  await p.getByLabel('Time window').selectOption('this week');
  await expect(p.locator('[data-failed-total] dd')).toHaveText('5,600');
  await expect(p.locator('[data-failed-source]')).toHaveText('From the query logs');
  expect(asked).toContain('this week');

  await p.getByLabel('Time window').selectOption('last 30 days');
  await expect(p.locator('[data-failed-total] dd')).toHaveText('78,000');
  expect(asked).toContain('last 30 days');

  // Remembered in this browser.
  await page.reload();
  await expect(panel(page).getByLabel('Time window')).toHaveValue('last 30 days');
  await expect(panel(page).locator('[data-failed-total] dd')).toHaveText('78,000');
});

test('a failed reply says "not checked", never 0', async ({ page }) => {
  await page.route('**/api/csp/dns-failures*', (route) => {
    const w = new URL(route.request().url()).searchParams.get('window') ?? '';
    return fulfillJson(route, {
      status: 'error', window: w, source: 'failure_records', total: null,
      codes: { nxdomain: null, servfail: null, refused: null, other: null }, codes_status: 'error',
      names: null, names_status: 'error',
    });
  });
  await page.goto('/#dns');
  const p = panel(page);
  await expect(p.locator('[data-failed-total] dd')).toHaveText('not checked');
  for (const code of ['nxdomain', 'servfail', 'refused', 'other']) {
    await expect(p.locator(`[data-failed-code="${code}"] dd`)).toHaveText('not checked');
  }
  await expect(p.locator('[data-failed-names]')).toHaveText('not checked');
  await expect(p.locator('dd', { hasText: /^0$/ })).toHaveCount(0);
});

test('a dead request says "not checked" too', async ({ page }) => {
  await page.route('**/api/csp/dns-failures*', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.goto('/#dns');
  await expect(panel(page).locator('[data-failed-total] dd')).toHaveText('not checked');
});
