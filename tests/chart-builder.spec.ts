import { test, expect } from './fixtures';
import { installFixtures } from './page-fixtures';

// The Build a chart tab, driven only by picking: the sentence follows the
// picks, choices that don't fit are hidden, every pick sends one allowed GET,
// and the "Show cube names" switch swaps the labels and is kept on reload.
//
// /api/chart answers by what was asked, so each assertion is about the picks
// the page actually sent rather than a single canned body.

const ROWS: Record<string, unknown[]> = {
  dns: [
    { 'NetworkNstarDnsActivity.device_name': 'ws-014.lab', 'NetworkNstarDnsActivity.device_ip': '10.20.0.24', 'NetworkNstarDnsActivity.total_query_count': '48211' },
  ],
  threats: [
    { 'PortunusAggThreat_ch.timestamp.day': '2026-10-20T00:00:00.000', 'PortunusAggThreat_ch.action': 'Block', 'PortunusAggThreat_ch.requests': '41' },
  ],
};

test.beforeEach(async ({ page }) => {
  await installFixtures(page, 'chart');
  await page.route('**/api/chart?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        status: 'ok',
        endpoint: q.get('count') === 'threats' ? '/api/cubejs-security/v1/query' : '/api/cubejs/v1/query',
        query: { measures: ['NetworkNstarDnsActivity.total_query_count'] },
        rows: ROWS[q.get('count') ?? ''] ?? [],
      },
    });
  });
});

const heading = (page: import('@playwright/test').Page) =>
  page.locator('[data-panel-id="chart-result"] h2, [data-panel-id="chart-result"] h3').first();

test('the sentence follows the picks', async ({ page }) => {
  await page.goto('/#chart');
  await expect(heading(page)).toHaveText('Top 10 devices by DNS queries, last 7 days');

  await page.getByLabel('What to count').selectOption({ label: 'Security hits' });
  await page.getByLabel('Over time').selectOption({ label: 'By day' });
  await page.getByLabel('When').selectOption({ label: 'Last 30 days' });
  await expect(heading(page)).toHaveText('Security hits by day, blocked vs allowed, last 30 days');
});

test('choices that do not fit are hidden, not greyed out', async ({ page }) => {
  await page.goto('/#chart');
  const split = page.getByLabel('Split by');
  await expect(split.locator('option')).toHaveText(['Device', 'Record type', 'Domain', 'Answer', 'Nothing, one total']);

  await page.getByLabel('What to count').selectOption({ label: 'DNS queries per second' });
  await expect(split.locator('option')).toHaveText(['Nothing, one total']);
  // Over time for today offers only By hour, and How many disappears.
  await page.getByLabel('When').selectOption({ label: 'Today' });
  await expect(page.getByLabel('Over time').locator('option')).toHaveText(['By hour', 'No, one total']);
  await expect(page.getByLabel('How many')).toHaveCount(0);
  await expect(page.locator('option[disabled]')).toHaveCount(0);
});

test('round two adds things to count and split by, each hidden where it does not fit', async ({ page }) => {
  await page.goto('/#chart');
  const count = page.getByLabel('What to count');
  const split = page.getByLabel('Split by');
  await expect(count.locator('option')).toHaveText(['DNS queries', 'Security hits', 'DNS queries per second', 'DHCP lease changes']);
  await expect(page.getByLabel('When').locator('option')).toHaveText(['Today', 'Last 24 hours', 'Last 7 days', 'Last 30 days']);

  // A domain is a top N only: over time offers nothing but one total.
  await split.selectOption({ label: 'Domain' });
  await expect(page.getByLabel('Over time').locator('option')).toHaveText(['No, one total']);
  await expect(heading(page)).toHaveText('Top 10 domains by DNS queries, last 7 days');

  await count.selectOption({ label: 'Security hits' });
  await expect(split.locator('option')).toHaveText(['What happened', 'Threat type', 'Policy', 'Severity', 'Nothing, one total']);
  // The security cube keeps one row a day: no rolling 24 hours, no by hour.
  await expect(page.getByLabel('When').locator('option')).toHaveText(['Today', 'Last 7 days', 'Last 30 days']);
  await split.selectOption({ label: 'Policy' });
  await expect(heading(page)).toHaveText('Top 10 policies by Security hits, last 7 days');

  await count.selectOption({ label: 'DHCP lease changes' });
  await expect(split.locator('option')).toHaveText(['What changed', 'Nothing, one total']);

  // Last 24 hours slices by hour, never by day.
  await split.selectOption({ label: 'Nothing, one total' });
  await page.getByLabel('When').selectOption({ label: 'Last 24 hours' });
  await expect(page.getByLabel('Over time').locator('option')).toHaveText(['By hour', 'No, one total']);
  await expect(heading(page)).toHaveText('DHCP lease changes by hour, last 24 hours');
  await expect(page.locator('option[disabled]')).toHaveCount(0);
});

test('how the chart was made is short labelled lines, the query folded away', async ({ page }) => {
  await page.goto('/#chart');
  const how = page.locator('[data-panel-id="chart-how"]');
  await expect(how.locator('dt')).toHaveText(['Counted', 'Split by', 'When', 'Showing']);
  await expect(how.locator('dd')).toHaveText(['DNS queries', 'Device', 'Last 7 days', 'Top 10, highest first']);
  await expect(page.getByText('The question, in plain words')).toHaveCount(0);

  // The real query and the first rows sit under one closed fold.
  const fold = how.locator('details');
  await expect(fold.locator('summary')).toHaveText('The query as sent');
  await expect(fold).not.toHaveAttribute('open', /.*/);
  await expect(how.locator('pre')).toBeHidden();
  await fold.locator('summary').click();
  await expect(how.locator('pre')).toContainText('NetworkNstarDnsActivity.total_query_count');
  await expect(how.locator('table')).toBeVisible();
});

test('every pick sends an allowed GET', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/chart') sent.push(u.search);
  });
  await page.goto('/#chart');
  await page.getByLabel('Split by').selectOption({ label: 'Record type' });
  await expect.poll(() => sent).toContain('?count=dns&split=qtype&window=7d&over=none&top=10');
});

test('the switch swaps the labels for cube names and is kept on reload', async ({ page }) => {
  await page.goto('/#chart');
  const sw = page.getByRole('switch', { name: 'Show cube names' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('What to count').locator('option:checked')).toHaveText('DNS queries');
  await expect(page.locator('[data-panel-id="chart-how"] th').first()).toHaveText('Device');

  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('What to count').locator('option:checked')).toHaveText('NetworkNstarDnsActivity.total_query_count');
  await expect(heading(page)).toHaveText(
    'NetworkNstarDnsActivity.total_query_count by NetworkNstarDnsActivity.device_name, NetworkNstarDnsActivity.device_ip, last 7 days, limit 10',
  );
  await expect(page.locator('[data-panel-id="chart-how"] th').first()).toHaveText('NetworkNstarDnsActivity.device_name');
  await expect(page.getByText('The question, in plain words')).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Show cube names' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('What to count').locator('option:checked')).toHaveText('NetworkNstarDnsActivity.total_query_count');
});

test('an upstream failure says so, and is not shown as no activity', async ({ page }) => {
  await page.route('**/api/chart?*', (route) =>
    route.fulfill({ json: { status: 'error', reason: 'Infoblox didn\'t answer this query (upstream error).', rows: [] } }),
  );
  await page.goto('/#chart');
  await expect(page.locator('[data-feed-unavailable="This chart could not be drawn"]')).toBeVisible();
  await expect(page.getByText('no activity')).toHaveCount(0);
});

test('no split and one total draws the total as a number', async ({ page }) => {
  await page.goto('/#chart');
  await page.getByLabel('Split by').selectOption({ label: 'Nothing, one total' });
  await page.getByLabel('Over time').selectOption({ label: 'No, one total' });
  await expect(heading(page)).toHaveText('DNS queries, last 7 days');
  await expect(page.getByRole('img', { name: 'Your chart: DNS queries, 48,211' })).toBeVisible();
});

test('names too long to sit under a bar lie sideways, each on a row of its own', async ({ page }) => {
  const long = 'telemetry.eu.example-cdn-provider.net';
  await page.route('**/api/chart?*', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        endpoint: '/api/cubejs/v1/query',
        query: {},
        rows: [{ 'NetworkNstarDnsActivity.qname': long, 'NetworkNstarDnsActivity.total_query_count': '900' }],
      },
    }),
  );
  await page.goto('/#chart?count=dns&split=domain&window=7d&over=none&top=10');
  await expect(page.locator('svg text').filter({ hasText: long })).toBeVisible();
});

test('every row Infoblox sent back can be saved as a CSV file', async ({ page }) => {
  await page.goto('/#chart');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download the 1 row as CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('dns-device-7d.csv');
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(await download.path(), 'utf8');
  expect(text).toBe('Device,Device address,DNS queries\r\nws-014.lab,10.20.0.24,48211\r\n');
});
