import { test, expect } from './fixtures';
import { installBaselineWorld, openTask } from './page-fixtures';

// Manage Records and Manage Addresses used to show the first 200 rows with no
// way to reach the rest. Now each has a search box and Show 200 more, and
// Delete/Release re-check the exact item wherever it sits in the list.

const ZONE = { id: 'zone1', fqdn: 'example.com' };
const rec = (i: number) => ({ id: `r${i}`, type: 'A', name_in_zone: `host${i}`, ttl: 300, dns_rdata: `10.0.${Math.floor(i / 250)}.${i % 250}`, comment: '' });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/dns/zones*', (r) => r.fulfill({ json: { zones: [ZONE] } }));
  await page.route('**/api/desk/spaces*', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill({ json: { spaces: [{ id: 'sp1', name: 'Lab' }] } }));
  await page.route('**/api/ipam/subnets*', (r) => r.fulfill({ json: { subnets: [{ id: 'sub1', address: '10.9.0.0', cidr: 16, name: 'big' }] } }));
});

test('a record past the first 200 can be shown, re-checked and deleted', async ({ page }) => {
  const seen: URL[] = [];
  await page.route('**/api/dns/records?*', (r) => {
    const u = new URL(r.request().url());
    seen.push(u);
    const off = Number(u.searchParams.get('_offset') || 0);
    if (u.searchParams.get('name')) return r.fulfill({ json: { records: [rec(250)] } });
    const rows = Array.from({ length: 200 }, (_, i) => rec(off + i)).filter((x) => Number(x.id.slice(1)) < 300);
    return r.fulfill({ json: { records: rows, total: 300, limit: 200 } });
  });
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  await expect(card.getByText('showing 200 of 300')).toBeVisible();
  await card.getByRole('button', { name: 'Show 200 more' }).click();
  await expect(card.getByText('10.0.1.0', { exact: true })).toBeVisible();
  await expect(card.getByText('showing 300 of 300')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Show 200 more' })).toHaveCount(0);

  const row = card.locator('.rounded-control.border.border-border.p-2').filter({ hasText: '10.0.1.0' });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row.getByText('Click again to delete A host250 -> 10.0.1.0')).toBeVisible();
  const reread = seen.find((u) => u.searchParams.get('name'));
  expect(reread?.searchParams.get('name')).toBe('host250');
  expect(reread?.searchParams.get('type')).toBe('A');
});

test('the record search asks the server, after typing stops', async ({ page }) => {
  const qs: string[] = [];
  await page.route('**/api/dns/records?*', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q');
    if (q) qs.push(q);
    return r.fulfill({ json: { records: q ? [rec(7)] : [rec(1)] } });
  });
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  await card.getByRole('searchbox', { name: 'Find a record' }).pressSequentially('host7');
  await expect(card.getByText('host7', { exact: true })).toBeVisible();
  expect(qs).toEqual(['host7']);
});

test('an address is found by its full IP', async ({ page }) => {
  const qs: string[] = [];
  await page.route('**/api/ipam/addresses?*', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q');
    if (q) qs.push(q);
    return r.fulfill({ json: { addresses: q ? [{ id: 'a9', address: '10.9.200.9', name: 'printer', state: 'used' }] : [], truncated: !q, limit: 200 } });
  });
  await page.goto('/#selfservice');
  const card = await openTask(page, 'addresses');
  await card.locator('select').first().selectOption('sp1');
  await card.locator('select').nth(1).selectOption('sub1');
  await card.getByRole('searchbox', { name: 'Find an address' }).fill('10.9.200.9');
  await expect(card.getByText('10.9.200.9')).toBeVisible();
  expect(qs).toContain('10.9.200.9');
});
