import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { FIXED_NOW, installBaselineWorld, openTask } from './page-fixtures';

// The safety and honest-results audit: a destructive press always has a separate
// confirm with no timer, a failed load never reads as "nothing here", and a
// failed action always says so. Every response is faked; nothing reaches a tenant.

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const sse = (...frames: unknown[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');

const ZONE = { id: 'zone1', fqdn: 'example.com' };
const SPACE = { id: 'space1', name: 'Default' };
const SUBNET = { id: 'subnet1', address: '10.0.0.0', cidr: 24, name: 'sub' };
const RECORD = { id: 'rec-1', type: 'A', name_in_zone: 'www', ttl: 300, dns_rdata: '192.0.2.10', comment: 'web' };
const ADDRESS = { id: 'ipam/address/1', address: '10.0.0.5', state: 'used', name: 'host-1', comment: 'lab' };
const rowOf = (scope: ReturnType<Page['locator']>, text: string) =>
  scope.locator('.rounded-control.border.border-border.p-2').filter({ hasText: text });

async function stubDelete(page: Page) {
  const live: Record<string, unknown>[] = [];
  await page.route('**/api/made/delete', (route) => {
    const b = route.request().postDataJSON();
    if (b.dry) return json(route, { ok: true, dry_run: true, label: b.id, made: false, changed: false, gone: false, blocked: '', confirm: 'code-1' });
    live.push(b);
    return json(route, { ok: true, already_gone: false });
  });
  return live;
}

async function openRecords(page: Page, records: unknown = { records: [RECORD] }, status = 200) {
  await page.route('**/api/dns/zones*', (r) => json(r, { zones: [ZONE] }));
  await page.route('**/api/dns/records*', (r) => json(r, records, status));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  return card;
}

async function openAddresses(page: Page) {
  await page.route('**/api/ipam/spaces*', (r) => json(r, { spaces: [SPACE] }));
  await page.route('**/api/ipam/subnets*', (r) => json(r, { subnets: [SUBNET] }));
  await page.route('**/api/ipam/addresses*', (r) => json(r, { addresses: [ADDRESS] }));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'addresses');
  await card.locator('select').first().selectOption(SPACE.id);
  await card.locator('select').nth(1).selectOption(SUBNET.id);
  return card;
}

const VAULT = {
  active: 'sales', exists: true, ready: true, unlocked: true, vaultMode: true, hasGroq: false,
  hasAxur: true, hasKentik: true, llm: { base_url: '', hasKey: false, model: '' },
  tenants: [{ id: 'lab', label: 'Example Lab' }, { id: 'sales', label: 'Example Sales' }],
  version: 'v3.81.1', writeAllowed: [],
};

async function openSettings(page: Page, status: unknown = VAULT) {
  await page.route('**/api/vault/status*', (r) => json(r, status));
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet).toBeVisible();
  return sheet;
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('1. a change with no recorded result is not called failed', async ({ page }) => {
  const ts = new Date(FIXED_NOW.getTime() - 60_000).toISOString();
  const base = { action: 'UPDATE', resource: 'dnsrecord', ts, user: 'actor', who_kind: 'person', who_role: '' };
  const rows = [{ ...base, id: 'u1', result: 'unknown' }, { ...base, id: 'b1', result: '' }, { ...base, id: 'f1', result: 'failure' }];
  await page.route('**/api/csp-audit*', (r) => json(r, { count: 3, rows, status: 'ok', truncated: false }));
  await page.goto('/#changes');
  await expect(page.locator('[data-flag="no-result"]')).toHaveCount(2);
  await expect(page.locator('[data-flag="no-result"]').first()).toHaveText('No result');
  await expect(page.locator('[data-flag="failed"]')).toHaveCount(1);
});

test('2. deleting a DNS record: separate red confirm, Cancel, and no timer', async ({ page }) => {
  const live = await stubDelete(page);
  const card = await openRecords(page);
  const row = rowOf(card, RECORD.dns_rdata);
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const yes = row.getByRole('button', { name: 'Confirm delete' });
  await expect(yes).toBeVisible();
  await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await page.waitForTimeout(4300);
  await expect(yes, 'the confirm must not time out').toBeVisible();
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(yes).toHaveCount(0);
  expect(live).toHaveLength(0);
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await row.getByRole('button', { name: 'Confirm delete' }).click();
  await expect.poll(() => live.length).toBe(1);
});

test('2. pressing Delete twice never deletes', async ({ page }) => {
  const live = await stubDelete(page);
  const card = await openRecords(page);
  const row = rowOf(card, RECORD.dns_rdata);
  const del = row.getByRole('button', { name: 'Delete', exact: true });
  await del.click();
  await expect(row.getByRole('button', { name: 'Confirm delete' })).toBeVisible();
  await del.click();
  await page.waitForTimeout(200);
  expect(live).toHaveLength(0);
});

test('2. releasing an address: separate confirm with no timer', async ({ page }) => {
  const live = await stubDelete(page);
  const card = await openAddresses(page);
  const row = rowOf(card, ADDRESS.address);
  await row.getByRole('button', { name: 'Release', exact: true }).click();
  const yes = row.getByRole('button', { name: 'Confirm release' });
  await expect(yes).toBeVisible();
  await expect(row.getByRole('button', { name: 'Release', exact: true })).toBeVisible();
  await page.waitForTimeout(4300);
  await expect(yes).toBeVisible();
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(yes).toHaveCount(0);
  expect(live).toHaveLength(0);
});

test('2. Editor delete: separate confirm with no timer', async ({ page }) => {
  const live = await stubDelete(page);
  await page.goto('/#editor?type=dns_zone&id=zone-1');
  const del = page.getByRole('button', { name: 'Delete DNS Zone' });
  await del.click();
  const yes = page.getByRole('button', { name: 'Permanently delete' });
  await expect(yes).toBeVisible();
  await expect(del).toBeVisible();
  await page.waitForTimeout(4300);
  await expect(yes).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(yes).toHaveCount(0);
  expect(live).toHaveLength(0);
});

for (const [name, path, remove, keep] of [
  ['Axur', '**/api/vault/axur', 'Remove Axur key', 'Keep Axur key'],
  ['Kentik', '**/api/vault/kentik', 'Remove Kentik login', 'Keep Kentik login'],
] as const) {
  test(`3. removing the saved ${name} login asks first`, async ({ page }) => {
    const posts: unknown[] = [];
    await page.route(path, (r) => { posts.push(r.request().postDataJSON()); return json(r, { ok: true, stored: false }); });
    const sheet = await openSettings(page);
    await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();
    await sheet.getByRole('button', { name: remove, exact: true }).click();
    expect(posts).toHaveLength(0);
    await sheet.getByRole('button', { name: keep, exact: true }).click();
    expect(posts).toHaveLength(0);
    await sheet.getByRole('button', { name: remove, exact: true }).click();
    await sheet.getByRole('button', { name: remove.replace('Remove', 'Confirm remove'), exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
  });
}

test('4. clearing seen marks takes two steps', async ({ page }) => {
  await page.goto('/#incidents');
  const panel = page.locator('[data-panel-id="incidents-triage"]');
  await expect(panel.getByRole('columnheader', { name: 'Seen' })).toBeVisible();
  const box = panel.getByRole('checkbox').first();
  await box.check();
  await panel.getByRole('button', { name: 'Clear seen marks', exact: true }).click();
  await expect(box).toBeChecked();
  await panel.getByRole('button', { name: 'Keep seen marks', exact: true }).click();
  await expect(box).toBeChecked();
  await panel.getByRole('button', { name: 'Clear seen marks', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm clear seen marks', exact: true }).click();
  await expect(box).not.toBeChecked();
});

const SITE_PREVIEW = sse({ step: 'plan' }, { done: true, result: { site: 'amer-lab', dry_run: true, subnets_deleted: [], dhcp_ranges_deleted: [], hosts_deleted: [] } });

async function openSiteTeardown(page: Page) {
  const seen: string[] = [];
  await page.route('**/api/teardown/site/stream*', (route) => {
    seen.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: SITE_PREVIEW });
  });
  await page.route('**/api/desk/spaces*', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.goto('/#provision');
  await page.getByRole('button', { name: 'Full site', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: /baseline-site/ }).first().selectOption('baseline-site');
  return { card: page.locator('[data-panel-id="provision-site-teardown"]'), seen };
}

test('5 and 6. teardown shows the real site name, needs an exact match, and typing keeps the preview', async ({ page }) => {
  const { card, seen } = await openSiteTeardown(page);
  await card.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(() => seen.length).toBe(1);
  await expect(card.getByText('amer-lab', { exact: true })).toBeVisible();
  const box = card.getByLabel(/Type the site name to confirm/i);
  const apply = card.getByRole('button', { name: 'Tear down this site', exact: true });

  await box.fill('baseline-site');
  await expect(apply, 'typing must not cancel the preview').toBeVisible();
  await expect(apply, 'the template name is not the site name').toBeDisabled();
  await box.fill('AMER-LAB');
  await expect(apply).toBeDisabled();
  await box.fill('amer-lab');
  await expect(apply).toBeEnabled();
  expect(seen[0]).not.toContain('confirm=');
  await apply.click();
  await expect.poll(() => seen.length).toBe(2);
  expect(seen[1]).toContain('confirm=amer-lab');
});

test('7. a failed list never says there is nothing', async ({ page }) => {
  await page.route('**/api/desk/runs', (r) => json(r, { error: 'down' }, 500));
  await page.goto('/#automate');
  await expect(page.locator('[data-panel-id="automate-recent"]').getByRole('alert')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Nothing built here yet.')).toHaveCount(0);
  await page.goto('/#made');
  await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Nothing made with Bloxsmith yet.')).toHaveCount(0);
});

test('7. a failed demo status does not say there are no runs', async ({ page }) => {
  await page.route('**/api/demo/status*', (r) => json(r, { error: 'down' }, 500));
  await page.goto('/#demo');
  const runs = page.locator('[data-panel-id="demo-runs"]');
  await expect(runs.locator('[data-feed-unavailable]')).toBeVisible({ timeout: 20_000 });
  await expect(runs.getByText('No demo runs yet.')).toHaveCount(0);
});

test('8. a failed load offers Try again, and it loads again', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/dns/zones*', (r) => json(r, { zones: [ZONE] }));
  await page.route('**/api/dns/records*', (r) => { reads += 1; return json(r, { error: 'down' }, 400); });
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  const retry = card.getByRole('alert').getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible({ timeout: 20_000 });
  const before = reads;
  await retry.click();
  await expect.poll(() => reads).toBeGreaterThan(before);
});

for (const status of [401, 403]) {
  test(`9. a ${status} says no permission and offers no retry`, async ({ page }) => {
    const card = await openRecords(page, { error: 'denied' }, status);
    await expect(card.getByText("You don't have permission to see this. Check the key in Settings.")).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test(`9. a ${status} on a whole feed says no permission, not unavailable`, async ({ page }) => {
    await page.route('**/api/incidents*', (r) => json(r, { error: 'denied' }, status));
    await page.goto('/#incidents');
    const panel = page.locator('[data-panel-id="incidents-triage"]');
    await expect(panel.getByText("You don't have permission to see this. Check the key in Settings.")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText('Incidents feed unavailable')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    // This panel puts words before the status, and must read the same.
    const categories = page.locator('[data-panel-id="incidents-categories"]');
    await expect(categories.getByText("You don't have permission to see this. Check the key in Settings.")).toBeVisible();
  });
}

test('10. a failed vault reset keeps the dialog open and says why', async ({ page }) => {
  await page.route('**/api/vault/status*', (r) => json(r, { ...VAULT, unlocked: false, ready: false }));
  await page.route('**/api/vault/reset', (r) => json(r, { ok: false, error: 'disk is read-only' }));
  await page.goto('/');
  await page.getByRole('button', { name: /Reset vault/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm vault reset' });
  await dialog.getByRole('button', { name: 'Reset vault' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('disk is read-only');
});

test('11. a failed tenant remove says why', async ({ page }) => {
  await page.route('**/api/vault/tenant-remove', (r) => json(r, { ok: false, error: 'cannot remove the active tenant' }));
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: 'Remove Example Lab' }).click();
  await sheet.getByRole('button', { name: 'Confirm remove Example Lab' }).click();
  await expect(sheet.getByRole('alert').filter({ hasText: 'cannot remove the active tenant' })).toBeVisible();
});

test('11. a failed tenant switch says why', async ({ page }) => {
  await page.route('**/api/vault/active', (r) => json(r, { ok: false, error: 'that key no longer works' }));
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: /○\s*Example Lab/ }).click();
  await expect(sheet.getByRole('alert').filter({ hasText: 'that key no longer works' })).toBeVisible();
});

for (const [name, open, text, action] of [
  ['DNS record', (p: Page) => openRecords(p), RECORD.dns_rdata, 'Delete'],
  ['address', (p: Page) => openAddresses(p), ADDRESS.address, 'Release'],
] as const) {
  test(`12. a ${name} row fits a 320px phone`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await stubDelete(page);
    const card = await open(page);
    const row = rowOf(card, text);
    const value = row.getByText(text, { exact: true }).first();
    await expect(value).toBeVisible();
    const v = (await value.boundingBox())!;
    const b = (await row.getByRole('button', { name: action, exact: true }).boundingBox())!;
    expect(v.width, 'the value has room').toBeGreaterThan(40);
    expect(v.x + v.width).toBeLessThanOrEqual(320);
    expect(b.x + b.width, 'the button is on screen').toBeLessThanOrEqual(320);
  });
}

test('13. a long tenant name is shown in full', async ({ page }) => {
  const long = 'Example Tenant With A Very Long Name That Used To Be Cut Off At The Edge Of The Row Number 12345';
  const sheet = await openSettings(page, { ...VAULT, tenants: [{ id: 'lab', label: long }, VAULT.tenants[1]] });
  const name = sheet.getByText(long, { exact: true });
  await expect(name).toBeVisible();
  const cut = await name.evaluate((e) => e.scrollWidth > e.clientWidth);
  expect(cut).toBe(false);
});

test('14. form results are announced', async ({ page }) => {
  await page.route('**/api/vault/conn-test', (r) => json(r, { ok: true, name: 'Example' }));
  await page.route('**/api/vault/axur', (r) => json(r, { ok: true, stored: true }));
  await page.route('**/api/vault/kentik', (r) => json(r, { ok: true, stored: true }));
  await page.route('**/api/switch-account', (r) => json(r, { ok: false, error: 'refused' }, 403));
  await page.route('**/api/accounts*', (r) => json(r, { accounts: [{ id: 'a1', name: 'One' }, { id: 'a2', name: 'Two' }], active: 'a1' }));
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: 'Test active connection' }).click();
  await expect(sheet.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  await sheet.getByLabel('Active CSP account').selectOption('a2');
  await expect(sheet.getByRole('alert').filter({ hasText: 'refused' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();
  await sheet.getByLabel('Axur API key').fill('token');
  await sheet.getByRole('button', { name: 'Save Axur key' }).click();
  await expect(sheet.getByRole('status').filter({ hasText: 'Axur key saved.' })).toBeVisible();
  await sheet.getByLabel('Kentik login email').fill('a@example.com');
  await sheet.getByLabel('Kentik API token').fill('token');
  await sheet.getByRole('button', { name: 'Save Kentik login' }).click();
  await expect(sheet.getByRole('status').filter({ hasText: 'Kentik login saved.' })).toBeVisible();
});

test('14. record results and errors are announced', async ({ page }) => {
  await stubDelete(page);
  const card = await openRecords(page);
  const row = rowOf(card, RECORD.dns_rdata);
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await row.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'DNS record deleted.' })).toBeVisible();
});
