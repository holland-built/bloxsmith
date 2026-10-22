import { test, expect, type APIRequestContext, type Page } from './fixtures';
import { installFixtures, ALL_PAGES } from './page-fixtures';

// "Add to a page": a chart made in Build a chart, saved onto a page, kept
// across a reload, moved with Arrange panels, and removed from its About.
//
// Saved views are REAL STATE here (page-fixtures.ts passes /api/views through
// to the server, which scripts/e2e.sh points at a temp dir). This file owns
// every __chart_ view and `__layout_infra`, and deletes them before and after
// each test. #infra because no other spec writes its layout.

const LAYOUT = '__layout_infra';
const NAME = 'Lease changes this week';

async function clean(request: APIRequestContext) {
  await request.delete(`/api/views/${LAYOUT}`);
  const views = (await (await request.get('/api/views')).json()).views as { name: string }[];
  for (const v of views.filter((x) => x.name.startsWith('__chart_'))) await request.delete(`/api/views/${v.name}`);
}

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page, request }) => {
  await clean(request);
  await installFixtures(page, ALL_PAGES);
  await page.route('**/api/chart?*', (route) =>
    route.fulfill({
      json: {
        status: 'ok', endpoint: '/api/cubejs/v1/query', query: { measures: ['NetworkNstarDhcpLeaseActivity.total_count'] },
        rows: [
          { 'NetworkNstarDhcpLeaseActivity.lease_op': 'Update', 'NetworkNstarDhcpLeaseActivity.total_count': '4701' },
          { 'NetworkNstarDhcpLeaseActivity.lease_op': 'Delete', 'NetworkNstarDhcpLeaseActivity.total_count': '2012' },
        ],
      },
    }),
  );
});
test.afterEach(async ({ request }) => clean(request));

const saved = (page: Page) => page.locator('[data-panel-id^="saved-"]');

async function addToInfra(page: Page) {
  await page.goto('/#chart');
  await page.getByLabel('What to count').selectOption({ label: 'DHCP lease changes' });
  await page.getByRole('button', { name: 'Add to a page' }).click();
  // The name starts as the chart's own sentence.
  await expect(page.getByLabel('Name on the page')).toHaveValue('Top 10 kinds of change by DHCP lease changes, last 7 days');
  await page.getByLabel('Name on the page').fill(NAME);
  await page.getByLabel('Page', { exact: true }).selectOption({ label: 'Infra' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added to Infra.' })).toBeVisible();
}

test('a chart added to a page shows there as a panel, and stays after a reload', async ({ page }) => {
  await addToInfra(page);
  await page.getByRole('link', { name: 'Open Infra' }).click();
  await expect(page).toHaveURL(/#infra$/);
  await expect(saved(page)).toHaveCount(1);
  await expect(saved(page).locator('h2')).toHaveText(NAME);
  await expect(saved(page).getByRole('application', { name: `${NAME} chart` })).toBeVisible();

  await page.reload();
  await expect(saved(page).locator('h2')).toHaveText(NAME);
  // Only Infra has it.
  await page.goto('/#dns');
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(saved(page)).toHaveCount(0);
});

test('cancel saves nothing', async ({ page, request }) => {
  await page.goto('/#chart');
  await page.getByRole('button', { name: 'Add to a page' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('Name on the page')).toHaveCount(0);
  const views = (await (await request.get('/api/views')).json()).views as { name: string }[];
  expect(views.filter((v) => v.name.startsWith('__chart_'))).toEqual([]);
});

test('Arrange panels lists the saved chart by its name and moves it', async ({ page }) => {
  await addToInfra(page);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto('/#infra');
  await expect(saved(page)).toHaveCount(1);
  const id = await saved(page).getAttribute('data-panel-id');
  const order = () => page.$$eval('[data-panel-id]', (els) => els.map((e) => e.getAttribute('data-panel-id')));
  const before = (await order()).indexOf(id);

  await page.locator('[data-layout-arrange]').first().click();
  const row = page.locator('[data-arrange-dialog] li').filter({ has: page.locator(`[data-arrange="up:${id}"]`) });
  await expect(row.locator('[data-arrange-name]')).toHaveText(NAME);
  await row.locator(`[data-arrange="up:${id}"]`).click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await order()).indexOf(id)).toBe(before - 1);

  await page.reload();
  await expect(saved(page)).toHaveCount(1);
  await expect.poll(async () => (await order()).indexOf(id)).toBe(before - 1);
});

test('Remove in the About takes it off the page for good', async ({ page }) => {
  await addToInfra(page);
  await page.goto('/#infra');
  await page.getByRole('button', { name: `About: ${NAME}`, exact: true }).click();
  await expect(page.getByText('A chart you made in Build a chart and added to this page.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove from this page' }).click();
  await expect(saved(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(saved(page)).toHaveCount(0);
});
