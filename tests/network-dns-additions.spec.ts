import { test, expect } from './fixtures';

// Network and DNS additions (2026-11-17), each pinned against the old code:
//  1. "Show unused networks" on the Network table: IPv4 /30 or larger with
//     only the network and broadcast address in use; /31, /32 and IPv6 are
//     said to be not checked;
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

test('Show unused networks lists only IPv4 networks with nothing but network and broadcast in use', async ({ page }) => {
  await network(page);
  const box = table(page).getByRole('checkbox', { name: 'Show unused networks (47,661)' });
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.click();
  await expect(page).toHaveURL(/unused=1/);
  const rows = table(page).locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: '10.0.0.0' })).toHaveCount(1);
  await expect(rows.filter({ hasText: '10.0.2.0' })).toHaveCount(1);
  await expect(table(page)).toContainText('/31, /32 and IPv6 networks were not checked')
  await expect(table(page)).toContainText('2 of them are in the 5 networks loaded here');
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
