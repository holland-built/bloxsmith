import { test, expect } from './fixtures';
import { installFixtures } from './page-fixtures';

// Build a chart's "Chart other Infoblox data": any data set Infoblox lists,
// picked by search, then its counts and fields. The server trims the catalog
// and checks every name (go/internal/dashboard/chart_cubes.go); this spec is
// about the screen: it loads the list only when asked, sends the picks it
// shows, and says "could not load" when the list fails, never "no data".

const CUBES = [
  { name: 'DnsActivityV1', title: 'DNS Activity', description: 'Every DNS query your servers answered.' },
  { name: 'PortunusAggThreat_ch', title: 'Threats', description: 'Security hits by policy.' },
  { name: 'NetworkDhcpLeasesV1', title: 'DHCP Leases', description: 'Leases handed out.' },
];

const FIELDS = {
  name: 'DnsActivityV1', title: 'DNS Activity', description: 'Every DNS query your servers answered.',
  measures: [
    { name: 'DnsActivityV1.total_query_count', title: 'Total Query Count', type: 'number' },
    { name: 'DnsActivityV1.unique_clients', title: 'Unique Clients', type: 'number' },
  ],
  dimensions: [
    { name: 'DnsActivityV1.device_name', title: 'Device Name', type: 'string' },
    { name: 'DnsActivityV1.qtype', title: 'Query Type', type: 'string' },
    { name: 'DnsActivityV1.timestamp', title: 'Timestamp', type: 'time' },
  ],
};

async function mockCatalog(page: import('@playwright/test').Page, cubes: unknown) {
  const asked: string[] = [];
  await page.route('**/api/chart/cubes', (route) => {
    asked.push('cubes');
    return route.fulfill({ json: cubes });
  });
  await page.route('**/api/chart/fields?*', (route) => route.fulfill({ json: { status: 'ok', cube: FIELDS } }));
  await page.route('**/api/chart/any?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    asked.push(q.toString());
    const split = q.get('split');
    const m = q.get('measure') ?? '';
    return route.fulfill({
      json: {
        status: 'ok',
        endpoint: '/api/cubejs/v1/query',
        query: { measures: [m] },
        rows: split ? [{ [split]: 'ws-014.lab', [m]: '48211' }, { [split]: 'ws-020.lab', [m]: '1200' }] : [{ [m]: '50123' }],
      },
    });
  });
  return asked;
}

const heading = (page: import('@playwright/test').Page) =>
  page.locator('[data-panel-id="chart-result"] h2, [data-panel-id="chart-result"] h3').first();

test('any data set: search, pick, chart, and back to the common charts', async ({ page }) => {
  await installFixtures(page, 'chart');
  const asked = await mockCatalog(page, { status: 'ok', cubes: CUBES });
  await page.goto('/#chart');
  await expect(heading(page)).toHaveText('Top 10 devices by DNS queries, last 7 days');
  // The 8 MB catalog is not touched until someone asks for it.
  expect(asked).toEqual([]);

  await page.getByRole('button', { name: 'Chart other Infoblox data' }).click();
  await expect(page.getByText('3 to choose from')).toBeVisible();
  await page.getByLabel('Search Infoblox data').fill('dns');
  await expect(page.getByText('1 of 3 match')).toBeVisible();
  await expect(page.getByLabel('Data', { exact: true }).locator('option')).toHaveText(['Choose…', 'DNS Activity']);
  await page.getByLabel('Data', { exact: true }).selectOption({ label: 'DNS Activity' });
  await expect(page.getByText('Every DNS query your servers answered.')).toBeVisible();

  await expect(page.getByLabel('What to count').locator('option')).toHaveText(['Total Query Count', 'Unique Clients']);
  // A date is a window, not a split.
  await expect(page.getByLabel('Split by').locator('option')).toHaveText(['Nothing, one total', 'Device Name', 'Query Type']);
  await expect(heading(page)).toHaveText('DNS Activity: Total Query Count, last 7 days');
  await expect(page.locator('[data-panel-id="chart-result"]')).toContainText('50,123');

  await page.getByLabel('Split by').selectOption({ label: 'Device Name' });
  await page.getByLabel('How many').selectOption({ label: 'Top 5' });
  await expect(heading(page)).toHaveText('DNS Activity: Total Query Count by Device Name, top 5, last 7 days');
  const last = new URLSearchParams(asked[asked.length - 1]);
  expect(Object.fromEntries(last)).toEqual({
    cube: 'DnsActivityV1', measure: 'DnsActivityV1.total_query_count', split: 'DnsActivityV1.device_name',
    top: '5', time: 'DnsActivityV1.timestamp', window: '7d',
  });

  await page.getByLabel('When').selectOption({ label: 'Any time' });
  await expect(heading(page)).toHaveText('DNS Activity: Total Query Count by Device Name, top 5');
  await expect.poll(() => new URLSearchParams(asked[asked.length - 1]).has('window')).toBe(false);

  // The "Show cube names" switch shows the names Infoblox uses.
  await page.getByRole('switch', { name: 'Show cube names' }).click();
  await expect(page.getByLabel('What to count').locator('option').first()).toHaveText('DnsActivityV1.total_query_count');
  await page.getByRole('switch', { name: 'Show cube names' }).click();

  await page.getByRole('button', { name: 'Back to common charts' }).click();
  await expect(heading(page)).toHaveText('Top 10 devices by DNS queries, last 7 days');
  await expect(page.getByLabel('What to count').locator('option')).toHaveText(['DNS queries', 'Security hits', 'DNS queries per second', 'DHCP lease changes', 'Assets', 'New assets still held']);
});

test('a failed catalog says it could not load, not that there is nothing', async ({ page }) => {
  await installFixtures(page, 'chart');
  await mockCatalog(page, { status: 'error', reason: "Infoblox didn't send its list of data." });
  await page.goto('/#chart');
  await page.getByRole('button', { name: 'Chart other Infoblox data' }).click();
  await expect(page.getByText('Could not load the list of Infoblox data')).toBeVisible();
  await expect(page.getByText(/to choose from|Nothing matches/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back to common charts' })).toBeVisible();
});
