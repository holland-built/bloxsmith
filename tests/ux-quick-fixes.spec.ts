import { test, expect } from '@playwright/test';
import { openTask } from './page-fixtures';

// The quick fixes from the UX audit of 2026-10-26: placeholders that say they
// are loading, chart bars that carry their numbers, a short top-N that says
// why, a subnet you can search for, and an address preview written as a
// sentence.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('a panel still waiting for its data says Loading, not a blank grey box', async ({ page }) => {
  // Hold the dashboard read so the Overview stays in its first paint. Since the
  // service board (#393) the only placeholder panel left on Overview is the DNS
  // chart, which reads dns-qps, not /api/data: hold that too, or an earlier test
  // in the same CI shard that already fetched it lets the chart skip Loading.
  await page.route('**/api/data*', () => new Promise(() => {}));
  await page.route('**/api/csp/dns-qps*', () => new Promise(() => {}));
  await page.goto('/#overview');
  await expect(page.getByRole('status').filter({ hasText: 'Loading…' }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Services at a glance' }).getByRole('button', { name: /^Hosts / })).toContainText('Loading…');
});

test('chart bars carry their numbers, and a short top 10 says why it is short', async ({ page }) => {
  await page.route(/\/api\/chart\?/, (r) =>
    r.fulfill(json({
      status: 'ok',
      endpoint: '/api/cubejs/v1/query',
      query: {},
      rows: [
        { 'DnsActivityV1.device_name': 'ws-1', 'DnsActivityV1.device_ip': '10.10.0.21', 'DnsActivityV1.total_query_count': '48211' },
        { 'DnsActivityV1.device_name': 'ws-2', 'DnsActivityV1.device_ip': '10.10.0.22', 'DnsActivityV1.total_query_count': '9120' },
      ],
    })),
  );
  await page.goto('/#chart');
  const card = page.locator('[data-chart-result]').filter({ has: page.getByRole('heading', { name: /^Top 10 devices/ }) });
  await expect(card.getByText('Only 2 have anything to count, so this shows all 2.')).toBeVisible();
  // The numbers are SVG text inside the chart, which is one image to a screen
  // reader, so they are found as drawn text rather than by role.
  await expect(card.locator('svg text', { hasText: '48,211' })).toBeVisible();
  await expect(card.locator('svg text', { hasText: '9,120' })).toBeVisible();
});

test('a subnet is found by typing, and the preview is a sentence', async ({ page }) => {
  const subnets = Array.from({ length: 300 }, (_, i) => ({ id: `ipam/subnet/${i}`, address: `10.${i >> 8}.${i & 255}.0`, cidr: 24, name: `site-${i}` }));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [{ id: 'ipam/ip_space/1', name: 'acme-systems' }] })));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill(json({ blocks: [] })));
  await page.route('**/api/ipam/subnets*', (r) => r.fulfill(json({ subnets })));
  await page.route('**/api/selfservice/allocate', (r) =>
    r.fulfill(json({ addresses: [{ address: '10.0.42.1', id: 'ipam/address/00000000-0000-0000-0000-000000000001' }] })),
  );
  await page.goto('/#selfservice');
  const panel = await openTask(page, 'address');
  await panel.getByRole('combobox', { name: 'IP Space' }).selectOption('ipam/ip_space/1');
  await panel.getByRole('searchbox', { name: 'Search Subnet' }).fill('site-42');
  await panel.getByRole('button', { name: '10.0.42.0/24 — site-42', exact: true }).click();
  await panel.getByPlaceholder('host-01').fill('printer-3');
  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(panel.getByText('This will take 10.0.42.1 in subnet 10.0.42.0/24 — site-42, named printer-3.')).toBeVisible();
  // The raw reply is still there for anyone checking ids, folded away.
  await expect(panel.getByText('ipam/address/00000000')).toBeHidden();
  await panel.getByText('Details', { exact: true }).click();
  await expect(panel.getByText(/ipam\/address\/00000000/)).toBeVisible();
});
