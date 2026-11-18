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
  await box.check();
  const rows = table(page).locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: '10.0.0.0' })).toHaveCount(1);
  await expect(rows.filter({ hasText: '10.0.2.0' })).toHaveCount(1);
  await expect(table(page)).toContainText('/31, /32 and IPv6 networks were not checked')
  await expect(table(page)).toContainText('2 of them are in the 5 networks loaded here');
});
