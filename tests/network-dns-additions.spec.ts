import { test, expect } from './fixtures';

// Network and DNS additions (2026-11-17), each pinned against the old code:
//  1. "Show unused networks" on the Network table: IPv4 /30 or larger with
//     only the network and broadcast address in use, paged from the server
//     across the whole tenant (2026-11-18); /31, /32 and IPv6 are said to be
//     not checked;
//  4. a "Cloud" column on networks and zones (AWS / Azure / GCP);
//  8. "Compare views" on the DNS tab for a zone that lives in two views.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const OK_META = { subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok', hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok' };
const dataPayload = (over: Record<string, unknown>) => ({
  subnets: [], leases: [], hosts: [], zones: [], dnsViews: [], secPolicies: [], feeds: [], auditLogs: [], _totals: {}, _meta: OK_META, ...over,
});

const SUBNETS = [
  { id: 's1', name: 'empty-24', addr: '10.0.0.0', cidr: 24, total: 256, used: 2, util: 1, site: 'HQ' },
  { id: 's2', name: 'busy-24', addr: '10.0.1.0', cidr: 24, total: 256, used: 50, util: 20, site: 'HQ',
    cloud: 'AWS', cloud_detail: 'Zone us-east-1a · subnet-0b9b8e950df11095c' },
  { id: 's3', name: 'empty-30', addr: '10.0.2.0', cidr: 30, total: 4, used: 2, util: 50, site: 'HQ',
    cloud: 'Azure', cloud_detail: 'Subscription e4c1fa5d-21a9-498b-b32c-921112f89dd9 · resource group tbrown1-rg' },
  { id: 's4', name: 'link-31', addr: '10.1.2.4', cidr: 31, total: 2, used: 2, util: 100, site: 'HQ' },
  { id: 's5', name: 'v6', addr: '2400:4800:80a0::', cidr: 44, total: 0, used: 0, util: 0, site: 'HQ' },
];

async function network(page: import('@playwright/test').Page) {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
  await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload({
    subnets: SUBNETS, _totals: { subnets: 72599, subnetsUnused: 47661 },
  })));
  await page.goto('/#network');
}

const table = (page: import('@playwright/test').Page) => page.locator('[data-panel-id="network-exhaustion"]');

// One page of the server's unused list (GET /api/ipam/subnets/unused), already
// in the table's row shape. Page 1 is full (50 rows, more pages); page 2 is the
// last (3 rows).
const unusedRow = (i: number, page: number) => ({
  id: `u${page}-${i}`, name: '', addr: `10.${50 + page}.${i}.0`, cidr: 24, total: 256, used: 2, util: 1, site: 'Lab', cloud: '',
});
async function unusedPages(page: import('@playwright/test').Page) {
  const asked: string[] = [];
  await page.route('**/api/ipam/subnets/unused*', (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') || 0);
    asked.push(String(offset));
    const n = offset === 0 ? 50 : 3;
    return fulfillJson(route, {
      subnets: Array.from({ length: n }, (_, i) => unusedRow(i, offset / 50)), offset, limit: 50, more: offset === 0,
    });
  });
  return asked;
}

test('Show unused networks pages through every unused network in the tenant, not just the loaded ones', async ({ page }) => {
  const asked = await unusedPages(page);
  await network(page);
  const box = table(page).getByRole('checkbox', { name: 'Show unused networks (47,661)' });
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.click();
  await expect(page).toHaveURL(/unused=1/);
  const rows = table(page).locator('tbody tr');
  await expect(table(page)).toContainText('Page 1');
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText('10.50.0.0');
  // The loaded networks are not what is listed: 10.0.0.0 is unused and loaded.
  await expect(rows.filter({ hasText: '10.0.0.0/' })).toHaveCount(0);
  await expect(table(page)).toContainText('47,661 unused across all networks');
  await expect(table(page)).toContainText('Search, site and column sorting are off while this is on');
  await expect(table(page)).toContainText('/31, /32 and IPv6 networks were not checked');
  await expect(table(page).getByRole('textbox', { name: 'Filter networks' })).toBeDisabled();
  await expect(table(page).getByRole('combobox', { name: 'Filter by site' })).toBeDisabled();
  await expect(table(page).getByRole('button', { name: 'Previous' })).toBeDisabled();

  await table(page).getByRole('button', { name: 'Next' }).click();
  await expect(table(page)).toContainText('Page 2');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('10.51.0.0');
  await expect(table(page).getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(asked).toEqual(['0', '50']);

  await table(page).getByRole('button', { name: 'Previous' }).click();
  await expect(table(page)).toContainText('Page 1');
  await expect(rows).toHaveCount(50);

  // Box off: today's table of loaded networks comes back, search and all.
  await box.click();
  await expect(page).not.toHaveURL(/unused=1/);
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: '10.0.0.0' })).toHaveCount(1);
  await expect(rows.filter({ hasText: '10.0.1.0' })).toHaveCount(1);
  await expect(table(page).getByRole('textbox', { name: 'Filter networks' })).toBeEnabled();
  await expect(table(page).getByRole('button', { name: 'Next' })).toHaveCount(0);
});

test('networks show which cloud they came from, with the account in the hover', async ({ page }) => {
  await network(page);
  const rows = table(page).locator('tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await expect(table(page).getByRole('columnheader', { name: /Cloud/ })).toBeVisible();
  const aws = rows.filter({ hasText: '10.0.1.0' }).getByText('AWS', { exact: true });
  await expect(aws).toHaveAttribute('title', 'Zone us-east-1a · subnet-0b9b8e950df11095c');
  await table(page).getByRole('checkbox', { name: /Tiny networks/ }).click();
  await expect(page).toHaveURL(/links=1/);
  const azure = rows.filter({ hasText: '10.0.2.0' }).getByText('Azure', { exact: true });
  await expect(azure).toHaveAttribute('title', /Subscription e4c1fa5d/);
});

const ZONES = [
  { id: 'dns/auth_zone/a', fqdn: 'lab.example.', view: 'inside', records: 0, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false,
    cloud: 'GCP', cloud_detail: 'Project gcp-sa-coreddi' },
  { id: 'dns/auth_zone/b', fqdn: 'lab.example.', view: 'outside', records: 0, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false },
  { id: 'dns/auth_zone/c', fqdn: 'solo.example.', view: 'inside', records: 0, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false },
];

async function dns(page: import('@playwright/test').Page) {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
  await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload({ zones: ZONES })));
  await page.goto('/#dns');
}

const zoneCard = (page: import('@playwright/test').Page) => page.locator('[data-panel-id="dns-zones"]');

test('zones show which cloud they came from', async ({ page }) => {
  await dns(page);
  await expect(zoneCard(page).getByRole('columnheader', { name: /Cloud/ })).toBeVisible({ timeout: 20_000 });
  const gcp = zoneCard(page).locator('tbody tr').filter({ hasText: 'inside' }).getByText('GCP', { exact: true });
  await expect(gcp.first()).toHaveAttribute('title', 'Project gcp-sa-coreddi');
});

const COMPARE = {
  status: 'partial',
  a: { records: 4, complete: true, note: '' },
  b: { records: 1000, complete: false, note: 'Infoblox stopped answering after 1,000 records, so the rest were not compared.' },
  same: 2,
  only_a: [{ name: 'old', type: 'CNAME', data: 'www.lab.example.', ttl: 300 }],
  only_b: [{ name: 'new', type: 'TXT', data: '"hello"', ttl: 300 }],
  different: [
    { name: 'app', type: 'A', what: 'value', a: [{ name: 'app', type: 'A', data: '10.0.0.3', ttl: 3600 }], b: [{ name: 'app', type: 'A', data: '10.0.0.30', ttl: 3600 }] },
    { name: 'mail', type: 'A', what: 'ttl', a: [{ name: 'mail', type: 'A', data: '10.0.0.2', ttl: 3600 }], b: [{ name: 'mail', type: 'A', data: '10.0.0.2', ttl: 60 }] },
  ],
};

test('Compare views lists what differs for a zone in two views, and says when a read stopped early', async ({ page }) => {
  let asked = '';
  await page.route('**/api/dns/zone-compare*', (route) => { asked = route.request().url(); return fulfillJson(route, COMPARE); });
  await dns(page);
  await zoneCard(page).getByRole('button', { name: 'Compare views' }).click();
  const box = page.getByRole('region', { name: 'Compare a zone in two views' });
  await expect(box.getByLabel('Zone')).toHaveValue('lab.example.');
  await expect(box.getByLabel('First view')).toHaveValue('dns/auth_zone/a');
  await expect(box.getByLabel('Second view')).toHaveValue('dns/auth_zone/b');
  await box.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(box).toContainText('Same in both: 2');
  await expect(box).toContainText('Only in inside: 1');
  await expect(box).toContainText('Only in outside: 1');
  await expect(box).toContainText('Different: 2');
  await expect(box).toContainText('Infoblox stopped answering after 1,000 records');
  await expect(box.getByRole('table', { name: 'Only in inside' })).toContainText('old');
  await expect(box.getByRole('table', { name: 'Only in outside' })).toContainText('new');
  const diff = box.getByRole('table', { name: 'Different' });
  await expect(diff.locator('tbody tr').filter({ hasText: 'app' })).toContainText('10.0.0.30');
  await expect(diff.locator('tbody tr').filter({ hasText: 'mail' })).toContainText('60');
  expect(asked).toContain('a=dns%2Fauth_zone%2Fa');
  expect(asked).toContain('b=dns%2Fauth_zone%2Fb');
});
