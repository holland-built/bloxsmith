import { test, expect } from './fixtures';

// Made with Bloxsmith (owner, 2026-11-13): what Bloxsmith made and deleted,
// Delete on each item, and a finder for other items. Every delete asks once,
// and the question says whether Bloxsmith made the item.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const HERE = 'tenant-a/-';
const RUNS = {
  tenant: HERE,
  runs: [
    { id: 'r-3', title: 'Deleted web.example.com', created: '2026-11-13T12:00:00Z', source: 'delete', tenant: HERE, status: 'built', note: 'Not made by Bloxsmith',
      objects: [{ id: 'dns/record/x', kind: 'dns_record', label: 'web.example.com', state: 'removed' }] },
    { id: 'r-2', title: 'Site list bloxsmith-test', created: '2026-11-13T11:00:00Z', source: 'lists', tenant: HERE, status: 'built',
      objects: [
        { id: '42', kind: 'custom_list', label: 'bloxsmith-test', state: 'created' },
        { id: '7/bloxsmith-test/action_log', kind: 'policy_rule', label: 'bloxsmith-test, log, in policy 7', state: 'created' },
      ] },
    { id: 'r-1', title: 'Reservation for 02:00:5e:10:00:01', created: '2026-11-13T10:00:00Z', source: 'address', tenant: 'tenant-b/-', status: 'built',
      objects: [{ id: 'dhcp/fixed_address/f1', kind: 'fixed_address', label: '10.99.0.2 for 02:00:5e:10:00:01', state: 'created' }] },
    { id: 'r-0', title: 'IP address', created: '2026-11-12T10:00:00Z', status: 'built',
      objects: [{ id: 'ipam/address/a1', kind: 'address', label: '10.7.0.4', state: 'created' }] },
  ],
};

async function stub(page: import('@playwright/test').Page, checks: Record<string, any>) {
  const live: Record<string, any>[] = [];
  await page.route('**/api/vault/write-target*', (r) => r.fulfill(json({ known: true, tenant: HERE, label: 'T', writable: true })));
  await page.route('**/api/desk/runs', (r) => r.fulfill(json(RUNS)));
  await page.route('**/api/made/delete', (r) => {
    const b = r.request().postDataJSON();
    if (b.dry) return r.fulfill(json({ ok: true, dry_run: true, kind: b.kind, id: b.id, gone: false, blocked: '', changed: false, confirm: `code-${b.id}`, ...checks[b.id] }));
    live.push(b);
    return r.fulfill(json({ ok: true }));
  });
  return live;
}

test('lists every change newest first, and a made item deletes after one check', async ({ page }) => {
  const live = await stub(page, {
    '7/bloxsmith-test/action_log': { label: 'bloxsmith-test, log, in policy main', made: true, made_on: '2026-11-13T11:00:00Z' },
  });
  await page.goto('/#made');
  await expect(page.getByRole('heading', { level: 1, name: 'Made with Bloxsmith' })).toBeVisible();

  const runs = page.locator('[data-made-run]');
  await expect(runs).toHaveCount(4);
  await expect(runs.nth(0)).toContainText('Deleted web.example.com');
  await expect(runs.nth(0)).toContainText('Not made by Bloxsmith');
  // Made on another tenant: listed, but no Delete, since its id means nothing here.
  await expect(runs.nth(2)).toContainText('another tenant');
  await expect(runs.nth(2).getByRole('button', { name: 'Delete' })).toHaveCount(0);
  // An older Automate run (no tenant recorded) keeps its Delete.
  await expect(runs.nth(3).getByRole('button', { name: 'Delete' })).toHaveCount(1);

  const rule = page.locator('[data-delete-check="7/bloxsmith-test/action_log"]');
  await rule.getByRole('button', { name: 'Delete' }).click();
  await expect(rule).toContainText(/Made by Bloxsmith on .+\. Safe to delete\./);
  expect(live).toHaveLength(0);
  await rule.getByRole('button', { name: 'Delete it' }).click();
  await expect.poll(() => live.length).toBe(1);
  expect(live[0]).toEqual({ kind: 'policy_rule', id: '7/bloxsmith-test/action_log', dry: false, confirm: 'code-7/bloxsmith-test/action_log' });
});

test('a list still in use says why and offers no Delete', async ({ page }) => {
  const live = await stub(page, { '42': { label: 'bloxsmith-test', made: true, made_on: '2026-11-13T11:00:00Z', blocked: 'Policy main still uses this list. Delete its rule first.' } });
  await page.goto('/#made');
  const list = page.locator('[data-delete-check="42"]');
  await list.getByRole('button', { name: 'Delete' }).click();
  await expect(list).toContainText('Policy main still uses this list. Delete its rule first.');
  await expect(list.getByRole('button', { name: 'Delete it' })).toHaveCount(0);
  await list.getByRole('button', { name: 'Cancel' }).click();
  await expect(list.getByRole('button', { name: 'Delete' })).toBeVisible();
  expect(live).toHaveLength(0);
});

test('something else is found and its check says it was not made by Bloxsmith', async ({ page }) => {
  const live = await stub(page, { 'dns/record/r9': { label: 'printer.example.com A', made: false } });
  const finds: string[] = [];
  await page.route('**/api/made/find*', (r) => {
    finds.push(new URL(r.request().url()).search);
    return r.fulfill(json({ ok: true, results: [{ id: 'dns/record/r9', label: 'printer.example.com A {"address":"10.1.1.9"}' }] }));
  });
  await page.goto('/#made');
  await page.getByRole('textbox', { name: 'Name or address' }).fill('printer');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.locator('[data-found] li')).toHaveCount(1);
  expect(finds).toEqual(['?kind=dns_record&q=printer']);

  const found = page.locator('[data-delete-check="dns/record/r9"]');
  await found.getByRole('button', { name: 'Delete' }).click();
  await expect(found).toContainText('Not made by Bloxsmith. Are you sure?');
  await found.getByRole('button', { name: 'Delete it' }).click();
  await expect.poll(() => live.length).toBe(1);
  await expect(page.locator('[data-found] li')).toHaveCount(0);
});

test('each page lists only what it made', async ({ page }) => {
  await stub(page, {});
  await page.route('**/api/lists/targets', (r) => r.fulfill(json({ ok: true, lists: [], policies: [], redirects: [] })));
  await page.goto('/#lists');
  const made = page.locator('[data-made-run]');
  await expect(made).toHaveCount(1);
  await expect(made).toContainText('Site list bloxsmith-test');

  await page.goto('/#automate');
  await expect(page.locator('[data-run]')).toHaveCount(1);
  await expect(page.locator('[data-run]')).toContainText('IP address');
});

test('on a read-only tenant the check still runs, and only the final Delete is off', async ({ page }) => {
  await stub(page, { '42': { label: 'bloxsmith-test', made: true, made_on: '2026-11-13T11:00:00Z' } });
  await page.route('**/api/vault/write-target*', (r) => r.fulfill(json({ known: true, tenant: HERE, label: 'T', writable: false })));
  await page.goto('/#made');
  const list = page.locator('[data-delete-check="42"]');
  await list.getByRole('button', { name: 'Delete' }).click();
  await expect(list).toContainText('Safe to delete.');
  await expect(list.getByRole('button', { name: 'Delete it' })).toBeDisabled();
});
