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

test('2. a delete check that lands after switching item never arms the delete', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  let checks = 0;
  await page.route('**/api/made/delete', async (route) => {
    checks += 1;
    await held;
    await json(route, { ok: true, dry_run: true, label: 'zone-1', made: true, changed: false, gone: false, blocked: '', confirm: 'code-1' });
  });
  await page.goto('/#editor?type=dns_zone&id=zone-1');
  await page.getByRole('button', { name: 'Delete DNS Zone' }).click();
  await expect.poll(() => checks).toBe(1);
  await page.getByRole('button', { name: /Address Block/ }).first().click();
  await page.getByPlaceholder(/existing object id/).fill('block-y');
  release();
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: 'Permanently delete' })).toHaveCount(0);
});

test('3. a saved login cannot be removed while a save is running', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/vault/kentik', async (r) => { await held; await json(r, { ok: true, stored: true }); });
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();
  await sheet.getByRole('button', { name: 'Remove Kentik login', exact: true }).click();
  await sheet.locator('#tm-kentik-email').fill('person@example.com');
  await sheet.locator('#tm-kentik-token').fill('replacement');
  await sheet.getByRole('button', { name: 'Save Kentik login' }).click();
  await expect(sheet.getByRole('button', { name: 'Confirm remove Kentik login', exact: true })).toBeDisabled();
  release();
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

test('a teardown delete with an unconfirmed answer is not called deleted or kept', async ({ page }) => {
  const body = sse({ step: 'plan' }, { done: true, result: {
    site: 'amer-lab', dry_run: false, dns_zone_deleted: false, dns_zone_fqdn: 'site-amer-lab.example.com',
    subnets_deleted: [], dhcp_ranges_deleted: [], hosts_deleted: [],
    dns_zone_unknown: true,
    unconfirmed_note: '1 item(s) may or may not have been deleted: site-amer-lab.example.com. Check them in the Editor.',
  } });
  await page.route('**/api/teardown/site/stream*', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body }));
  await page.route('**/api/desk/spaces*', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.goto('/#provision');
  await page.getByRole('button', { name: 'Full site', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: /baseline-site/ }).first().selectOption('baseline-site');
  const card = page.locator('[data-panel-id="provision-site-teardown"]');
  await card.getByRole('button', { name: 'Preview', exact: true }).click();
  const result = page.locator('[data-panel-id="provision-site-teardown-result"]');
  await expect(result).toContainText('(result unknown)');
  await expect(result).not.toContainText('(kept)');
  await expect(result).toContainText('1 item(s) may or may not have been deleted: site-amer-lab.example.com. Check them in the Editor.');
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
    await expect(panel.getByText('Incidents information is unavailable')).toHaveCount(0);
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

// ---------- final review: late answers and real upstream refusals ----------

const deferred = () => {
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  return { held, release: () => release() };
};
const NO_PERM = "You don't have permission to see this. Check the key in Settings.";
const REFUSED = "Infoblox refused the call (HTTP 403). This key's user probably needs the ib-mcp-server-user group (Infoblox ticket PTCI-4674).";
const REC_A = { ...RECORD, id: 'rec-a', name_in_zone: 'alpha', dns_rdata: '192.0.2.21' };
const REC_B = { ...RECORD, id: 'rec-b', name_in_zone: 'beta', dns_rdata: '192.0.2.22' };
const ADDR_A = { ...ADDRESS, id: 'addr-a', address: '10.0.0.21', name: 'alpha' };
const ADDR_B = { ...ADDRESS, id: 'addr-b', address: '10.0.0.22', name: 'beta' };

// The dry check for one id waits until released; the others answer at once.
async function holdCheck(page: Page, id: string) {
  const gate = deferred();
  await page.route('**/api/made/delete', async (route) => {
    const b = route.request().postDataJSON();
    if (b.id === id) await gate.held;
    return json(route, { ok: true, dry_run: true, label: b.id, made: false, changed: false, gone: false, blocked: '', confirm: `code-${b.id}` });
  });
  return gate;
}

async function openTwoRecords(page: Page) {
  await page.route('**/api/dns/zones*', (r) => json(r, { zones: [ZONE, { id: 'zone2', fqdn: 'other.example' }] }));
  await page.route('**/api/dns/records*', (r) => json(r, { records: [REC_A, REC_B] }));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  return card;
}

async function openTwoAddresses(page: Page) {
  await page.route('**/api/ipam/spaces*', (r) => json(r, { spaces: [SPACE] }));
  await page.route('**/api/ipam/subnets*', (r) => json(r, { subnets: [SUBNET, { ...SUBNET, id: 'subnet2', address: '10.0.1.0' }] }));
  await page.route('**/api/ipam/addresses*', (r) => json(r, { addresses: [ADDR_A, ADDR_B] }));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'addresses');
  await card.locator('select').first().selectOption(SPACE.id);
  await card.locator('select').nth(1).selectOption(SUBNET.id);
  return card;
}

test('R1. a late record check cannot move the open confirm to another row', async ({ page }) => {
  const gate = await holdCheck(page, REC_A.id);
  const card = await openTwoRecords(page);
  await rowOf(card, REC_A.dns_rdata).getByRole('button', { name: 'Delete', exact: true }).click();
  await rowOf(card, REC_B.dns_rdata).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rowOf(card, REC_B.dns_rdata).getByRole('button', { name: 'Confirm delete' })).toBeVisible();
  gate.release();
  await page.waitForTimeout(300);
  await expect(rowOf(card, REC_B.dns_rdata).getByRole('button', { name: 'Confirm delete' })).toBeVisible();
  await expect(rowOf(card, REC_A.dns_rdata).getByRole('button', { name: 'Confirm delete' })).toHaveCount(0);
});

test('R1. Cancel stops a record check that is still running', async ({ page }) => {
  const gate = await holdCheck(page, REC_B.id);
  const card = await openTwoRecords(page);
  const a = rowOf(card, REC_A.dns_rdata);
  await a.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Confirm delete' })).toBeVisible();
  await rowOf(card, REC_B.dns_rdata).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(150);
  await a.getByRole('button', { name: 'Cancel' }).click();
  gate.release();
  await page.waitForTimeout(300);
  await expect(card.getByRole('button', { name: 'Confirm delete' })).toHaveCount(0);
});

test('R1. changing the zone stops a record check that is still running', async ({ page }) => {
  const gate = await holdCheck(page, REC_A.id);
  const card = await openTwoRecords(page);
  await rowOf(card, REC_A.dns_rdata).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(150);
  await card.locator('select').selectOption('zone2');
  await expect(rowOf(card, REC_A.dns_rdata)).toBeVisible();
  gate.release();
  await page.waitForTimeout(300);
  await expect(card.getByRole('button', { name: 'Confirm delete' })).toHaveCount(0);
});

test('R1. Cancel and a subnet change stop an address check that is still running', async ({ page }) => {
  const gate = await holdCheck(page, ADDR_B.id);
  const card = await openTwoAddresses(page);
  const a = rowOf(card, ADDR_A.address);
  await a.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Confirm release' })).toBeVisible();
  await rowOf(card, ADDR_B.address).getByRole('button', { name: 'Release', exact: true }).click();
  await page.waitForTimeout(150);
  await a.getByRole('button', { name: 'Cancel' }).click();
  gate.release();
  await page.waitForTimeout(300);
  await expect(card.getByRole('button', { name: 'Confirm release' })).toHaveCount(0);
});

test('R1. changing the subnet stops an address check that is still running', async ({ page }) => {
  const gate = await holdCheck(page, ADDR_A.id);
  const card = await openTwoAddresses(page);
  await rowOf(card, ADDR_A.address).getByRole('button', { name: 'Release', exact: true }).click();
  await page.waitForTimeout(150);
  await card.locator('select').nth(1).selectOption('subnet2');
  await expect(rowOf(card, ADDR_A.address)).toBeVisible();
  gate.release();
  await page.waitForTimeout(300);
  await expect(card.getByRole('button', { name: 'Confirm release' })).toHaveCount(0);
});

test('R2. a teardown preview whose inputs changed while it ran lands stale', async ({ page }) => {
  const gate = deferred();
  const seen: string[] = [];
  await page.route('**/api/teardown/site/stream*', async (route) => {
    seen.push(route.request().url());
    await gate.held;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: SITE_PREVIEW });
  });
  await page.route('**/api/desk/spaces*', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.goto('/#provision');
  await page.getByRole('button', { name: 'Full site', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: /baseline-site/ }).first().selectOption('baseline-site');
  const card = page.locator('[data-panel-id="provision-site-teardown"]');
  await card.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(() => seen.length).toBe(1);
  await page.locator('[data-panel-id="provision-site-request"] select').first().selectOption('Baseline Space');
  gate.release();
  await expect(card.getByText('inputs changed — preview again')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Tear down this site', exact: true })).toHaveCount(0);
  await expect(card.getByText('amer-lab', { exact: true })).toHaveCount(0);
  await expect(card.getByText('Press Preview to see the site name.')).toBeVisible();
});

for (const status of [401, 403]) {
  test(`R3. a real upstream ${status} on a list read says no permission and does not retry`, async ({ page }) => {
    let reads = 0;
    await page.route('**/api/dns/zones*', (r) => json(r, { zones: [ZONE] }));
    // The exact shape go/internal/server/ipam.go writeUpstreamError sends.
    await page.route('**/api/dns/records*', (r) => { reads += 1; return json(r, { error: 'Infoblox request failed', status, upstream: 'denied' }, 502); });
    await page.goto('/#selfservice');
    const card = await openTask(page, 'records');
    await card.locator('select').selectOption(ZONE.id);
    await expect(card.getByText(NO_PERM)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await page.waitForTimeout(2500);
    expect(reads).toBe(1);
  });
}

test('R3. another upstream failure on a list read is still an outage', async ({ page }) => {
  await page.route('**/api/dns/zones*', (r) => json(r, { zones: [ZONE] }));
  await page.route('**/api/dns/records*', (r) => json(r, { error: 'Infoblox request failed', status: 500 }, 502));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  await expect(card.getByText(/Could not load current data: The server had a problem\./)).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(NO_PERM)).toHaveCount(0);
});

test('R4. Changes shows no permission when the audit read was refused', async ({ page }) => {
  await page.route('**/api/csp-audit*', (r) => json(r, { rows: [], count: 0, truncated: false, status: 'error', permission_denied: true }));
  await page.goto('/#changes');
  await expect(page.locator('[data-panel-id="changes-notability"]').getByText(NO_PERM)).toBeVisible();
  await expect(page.locator('[data-panel-id="changes-changed-objects"]').getByText(NO_PERM)).toBeVisible();
  await expect(page.getByText('Portal audit information is unavailable')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('R4. Changes still says unavailable for any other audit failure', async ({ page }) => {
  await page.route('**/api/csp-audit*', (r) => json(r, { rows: [], count: 0, truncated: false, status: 'error' }));
  await page.goto('/#changes');
  await expect(page.getByText('Portal audit information is unavailable').first()).toBeVisible();
  await expect(page.getByText(NO_PERM)).toHaveCount(0);
});

test('R5. a refused IQ Actions read is a permission problem and keeps its reason', async ({ page }) => {
  await page.route(/\/api\/actions(\?.*)?$/, (r) => json(r, { actions: [], unavailable: REFUSED, availability: 'error' }));
  await page.goto('/#incidents');
  const queue = page.locator('[data-panel-id="incidents-soc-queue"]');
  await expect(queue.getByText(REFUSED)).toBeVisible();
  await expect(queue.getByText('No permission')).toBeVisible();
  await expect(queue.getByText('IQ Actions information is unavailable')).toHaveCount(0);
  await expect(queue.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('R6. Cancel is off while a key replacement is saving', async ({ page }) => {
  const gate = deferred();
  await page.route('**/api/vault/tenant-update', async (r) => { await gate.held; return json(r, { ok: false, error: 'bad key' }); });
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: 'Change key for Example Lab' }).click();
  await sheet.getByLabel('New Infoblox API key').fill('new-key');
  await sheet.getByRole('button', { name: 'Replace key' }).click();
  await expect(sheet.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  gate.release();
  await expect(sheet.getByRole('alert').filter({ hasText: 'bad key' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
});

test('R6. a key test answering after Cancel does not reopen the form', async ({ page }) => {
  const gate = deferred();
  await page.route('**/api/vault/test-key', async (r) => { await gate.held; return json(r, { ok: true, name: 'Example' }); });
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: 'Change key for Example Lab' }).click();
  await sheet.getByLabel('New Infoblox API key').fill('new-key');
  await sheet.getByRole('button', { name: 'Test', exact: true }).click();
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(sheet.getByLabel('New Infoblox API key')).toHaveCount(0);
  gate.release();
  await page.waitForTimeout(300);
  await expect(sheet.getByLabel('New Infoblox API key')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Change key for Example Lab' })).toBeVisible();
});

// ---------- last round: saves in flight, late key tests, stale denials ----------

async function holdPost(page: Page, path: string, body: unknown) {
  const gate = deferred();
  await page.route(path, async (r) => { await gate.held; return json(r, body); });
  return gate;
}

test('L1. Cancel on the Add form is off while adding', async ({ page }) => {
  const gate = await holdPost(page, '**/api/vault/tenant', { ok: false, error: 'bad key' });
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: '+ Add connection' }).click();
  await sheet.getByLabel('Infoblox API key').fill('new-key');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  gate.release();
  await expect(sheet.getByRole('alert').filter({ hasText: 'bad key' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
});

const SAVES: [string, string, (s: ReturnType<Page['getByRole']>) => Promise<void>][] = [
  ['adding a connection', '**/api/vault/tenant', async (s) => {
    await s.getByRole('button', { name: '+ Add connection' }).click();
    await s.getByLabel('Infoblox API key').fill('new-key');
    await s.getByRole('button', { name: 'Add', exact: true }).click();
  }],
  ['replacing a key', '**/api/vault/tenant-update', async (s) => {
    await s.getByRole('button', { name: 'Change key for Example Lab' }).click();
    await s.getByLabel('New Infoblox API key').fill('new-key');
    await s.getByRole('button', { name: 'Replace key' }).click();
  }],
  ['saving the Axur key', '**/api/vault/axur', async (s) => {
    await s.getByRole('button', { name: 'Integrations', exact: true }).click();
    await s.getByLabel('Axur API key').fill('token');
    await s.getByRole('button', { name: 'Save Axur key' }).click();
  }],
  ['saving the Kentik login', '**/api/vault/kentik', async (s) => {
    await s.getByRole('button', { name: 'Integrations', exact: true }).click();
    await s.getByLabel('Kentik login email').fill('a@example.com');
    await s.getByLabel('Kentik API token').fill('token');
    await s.getByRole('button', { name: 'Save Kentik login' }).click();
  }],
];
for (const [name, path, start] of SAVES) {
  test(`L2. the drawer stays open while ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const gate = await holdPost(page, path, { ok: false, error: 'save refused' });
    const sheet = await openSettings(page);
    await start(sheet);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    gate.release();
    await expect(sheet.getByRole('alert').filter({ hasText: 'save refused' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });
}

test('L3. a late Add key test does not land on a different key', async ({ page }) => {
  const gate = await holdPost(page, '**/api/vault/test-key', { ok: true, name: 'Example' });
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: '+ Add connection' }).click();
  await sheet.getByLabel('Infoblox API key').fill('key-one');
  await sheet.getByRole('button', { name: 'Test', exact: true }).click();
  await sheet.getByLabel('Infoblox API key').fill('key-two');
  gate.release();
  await page.waitForTimeout(300);
  await expect(sheet.getByText(/Key valid/)).toHaveCount(0);
});

test('L3. a late Replace key test does not land on another tenant form', async ({ page }) => {
  const gate = await holdPost(page, '**/api/vault/test-key', { ok: true, name: 'Example' });
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: 'Change key for Example Lab' }).click();
  await sheet.getByLabel('New Infoblox API key').fill('same-key');
  await sheet.getByRole('button', { name: 'Test', exact: true }).click();
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await sheet.getByRole('button', { name: 'Change key for Example Sales' }).click();
  await sheet.getByLabel('New Infoblox API key').fill('same-key');
  gate.release();
  await page.waitForTimeout(300);
  await expect(sheet.getByText(/Key valid/)).toHaveCount(0);
});

test('L3. a key test still reports on the key it tested', async ({ page }) => {
  const gate = await holdPost(page, '**/api/vault/test-key', { ok: true, name: 'Example' });
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name: 'Change key for Example Lab' }).click();
  await sheet.getByLabel('New Infoblox API key').fill('same-key');
  await sheet.getByRole('button', { name: 'Test', exact: true }).click();
  gate.release();
  await expect(sheet.getByText('Key valid — Example')).toBeVisible();
});

test('L4. an old denial does not hide a newer failure on Changes', async ({ page }) => {
  await page.clock.install({ time: FIXED_NOW });
  let fail = false;
  await page.route('**/api/csp-audit*', (r) => (fail
    ? json(r, { error: 'down' }, 500)
    : json(r, { rows: [], count: 0, truncated: false, status: 'error', permission_denied: true })));
  await page.goto('/#changes');
  await page.clock.runFor(100);
  await expect(page.getByText(NO_PERM).first()).toBeVisible();
  fail = true;
  await page.clock.fastForward(10 * 60 * 1000);
  await page.clock.runFor(1000);
  await expect(page.getByText('Portal audit information is unavailable').first()).toBeVisible();
  await expect(page.getByText(NO_PERM)).toHaveCount(0);
});

test('L5. the Audit tab shows no permission for a refused portal read', async ({ page }) => {
  await page.route('**/api/csp-audit*', (r) => json(r, { rows: [], count: 0, truncated: false, status: 'error', permission_denied: true }));
  await page.goto('/#audit');
  const panel = page.locator('[data-panel-id="audit-csp-portal"]');
  await expect(panel.getByText(NO_PERM)).toBeVisible();
  await expect(panel.getByText('Portal audit information is unavailable')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('L5. the Audit tab keeps Try again for any other portal failure', async ({ page }) => {
  await page.route('**/api/csp-audit*', (r) => json(r, { rows: [], count: 0, truncated: false, status: 'error' }));
  await page.goto('/#audit');
  const panel = page.locator('[data-panel-id="audit-csp-portal"]');
  await expect(panel.getByText('Portal audit information is unavailable')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
});
