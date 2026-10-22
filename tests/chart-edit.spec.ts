import { test, expect, type APIRequestContext, type Page } from './fixtures';
import { installFixtures, ALL_PAGES } from './page-fixtures';

// Opening an existing chart in Build a chart, saving changes to a saved one,
// and replacing a built-in panel with a chart and restoring it.
//
// Saved views are real state (page-fixtures.ts passes /api/views through to
// the temp store scripts/e2e.sh sets up). This file borrows `__layout_dns`
// from layout-drag.spec.ts, the way layout-save-feedback.spec.ts borrows
// `__layout_security`: deleted before and after every test, and
// playwright.config.ts runs one worker so the two files never interleave. It
// owns every __chart_ view while it runs.

const LAYOUT = '__layout_dns';
const VOLUME = 'dns-query-volume-7d';

async function clean(request: APIRequestContext) {
  await request.delete(`/api/views/${LAYOUT}`);
  const views = (await (await request.get('/api/views')).json()).views as { name: string }[];
  for (const v of views.filter((x) => x.name.startsWith('__chart_'))) await request.delete(`/api/views/${v.name}`);
}
const chartViews = async (request: APIRequestContext) =>
  ((await (await request.get('/api/views')).json()).views as { name: string }[]).filter((v) => v.name.startsWith('__chart_'));

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page, request }) => {
  await clean(request);
  await installFixtures(page, ALL_PAGES);
  await page.route('**/api/chart?*', (route) =>
    route.fulfill({
      json: {
        status: 'ok', endpoint: '/api/cubejs/v1/query', query: { measures: ['NetworkNstarDnsActivity.total_query_count'] },
        rows: [{ 'NetworkNstarDnsActivity.timestamp.day': '2026-10-20T00:00:00.000', 'NetworkNstarDnsActivity.total_query_count': '900' }],
      },
    }),
  );
});
test.afterEach(async ({ request }) => clean(request));

const heading = (page: Page) => page.locator('[data-panel-id="chart-result"] h2');
const saved = (page: Page) => page.locator('[data-panel-id^="saved-"]');

async function openAbout(page: Page, name: string) {
  await page.getByRole('button', { name: `About: ${name}`, exact: true }).click();
}

test('a panel Build a chart can draw opens there on its own picks', async ({ page }) => {
  await page.goto('/#dns');
  await openAbout(page, 'Query Volume — 7d');
  await page.getByRole('link', { name: 'Open in Build a chart' }).click();
  await expect(page).toHaveURL(/#chart\?count=dns&split=none&window=7d&over=day$/);
  await expect(heading(page)).toHaveText('DNS queries by day, last 7 days');
  // A panel it can't draw offers neither link.
  await page.goto('/#dns');
  await openAbout(page, 'DNS Zones');
  await expect(page.getByRole('link', { name: 'Open in Build a chart' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Replace this panel' })).toHaveCount(0);
});

test('a copy-only panel can be opened but not replaced', async ({ page }) => {
  await page.goto('/#overview');
  await openAbout(page, 'DNS Query Rate — 24h');
  await expect(page.getByRole('link', { name: 'Open in Build a chart' })).toHaveAttribute('href', '#chart?count=qps&split=none&window=24h&over=hour');
  await expect(page.getByRole('link', { name: 'Replace this panel' })).toHaveCount(0);
});

test('a link with picks that do not fit snaps to ones that do', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/chart') sent.push(u.search);
  });
  await page.goto('/#chart?count=threats&split=domain&window=24h&over=hour&top=999');
  await expect(page.getByLabel('What to count').locator('option:checked')).toHaveText('Security hits');
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent.every((s) => s.startsWith('?count=threats&split=action'))).toBe(true);
});

test('replace hides the original, survives a reload, and restore brings it back', async ({ page, request }) => {
  await page.goto('/#dns');
  await expect(page.locator(`[data-panel-id="${VOLUME}"]`)).toBeVisible();
  await openAbout(page, 'Query Volume — 7d');
  await page.getByRole('link', { name: 'Replace this panel' }).click();
  await expect(page.getByText('Replace Query Volume — 7d on DNS')).toBeVisible();
  await page.getByLabel('When').selectOption({ label: 'Last 30 days' });
  await page.getByLabel('Name on the page').fill('Queries, last 30 days');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Replaced on DNS.' })).toBeVisible();

  await page.getByRole('link', { name: 'Open DNS' }).click();
  await expect(saved(page).locator('h2')).toHaveText('Queries, last 30 days');
  await expect(page.locator(`[data-panel-id="${VOLUME}"]`)).toHaveCount(0);
  await page.reload();
  await expect(saved(page)).toHaveCount(1);
  await expect(page.locator(`[data-panel-id="${VOLUME}"]`)).toHaveCount(0);

  await openAbout(page, 'Queries, last 30 days');
  await page.getByRole('button', { name: 'Restore original' }).click();
  await expect(page.locator(`[data-panel-id="${VOLUME}"]`)).toBeVisible();
  await expect(saved(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`[data-panel-id="${VOLUME}"]`)).toBeVisible();
  await expect(saved(page)).toHaveCount(0);
  expect(await chartViews(request)).toEqual([]);
});

test('cancel on replace writes nothing', async ({ page, request }) => {
  await page.goto('/#dns');
  await openAbout(page, 'Query Volume — 7d');
  await page.getByRole('link', { name: 'Replace this panel' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/#dns$/);
  expect(await chartViews(request)).toEqual([]);
  expect((await request.get(`/api/views/${LAYOUT}`)).status()).toBe(404);
  await expect(page.locator(`[data-panel-id="${VOLUME}"]`)).toBeVisible();
});

test('a saved chart opens in the builder and Save changes it in place', async ({ page, request }) => {
  const id = 'k3x9q2m7ab12';
  await request.post('/api/views', {
    data: { name: `__chart_${id}`, chart: { v: 1, title: 'Top domains', tab: 'infra', picks: { count: 'dns', split: 'domain', window: '7d', over: 'none', top: 10 } } },
  });
  await page.goto('/#infra');
  await openAbout(page, 'Top domains');
  await page.getByRole('link', { name: 'Open in Build a chart' }).click();
  await expect(page).toHaveURL(new RegExp(`saved=${id}`));
  await expect(heading(page)).toHaveText('Top 10 domains by DNS queries, last 7 days');
  await page.getByLabel('How many').selectOption({ label: 'Top 5' });
  await page.getByRole('button', { name: 'Save changes to Top domains' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

  const views = await chartViews(request);
  expect(views.map((v) => v.name)).toEqual([`__chart_${id}`]);
  const rec = await (await request.get(`/api/views/__chart_${id}`)).json();
  expect(rec.chart).toMatchObject({ title: 'Top domains', tab: 'infra', picks: { split: 'domain', top: 5 } });
});
