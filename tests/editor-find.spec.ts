import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Editor used to need an opaque ID pasted in, with a blank form. Now an item
// is found by name and picked, the form fills with its values, and Update
// sends only what was changed.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('find a host, change only its comment, and Update sends just that', async ({ page }) => {
  const finds: string[] = [];
  await page.route('**/api/edit/host/find*', (r) => {
    finds.push(new URL(r.request().url()).searchParams.get('q') || '');
    return r.fulfill({ json: { items: [{ id: 'ipam/host/7', label: 'web7', fields: { name: 'web7', addresses: '10.0.0.7', comment: 'rack 2' } }] } });
  });
  let patched: Record<string, unknown> | null = null;
  await page.route('**/api/edit/host/*', (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback();
    patched = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, dry_run: true, would_update: {} } });
  });
  await page.goto('/#editor?type=host');
  await page.getByPlaceholder('Find by name or comment').fill('web');
  await page.getByRole('button', { name: 'web7' }).click();
  await expect(page.getByRole('textbox', { name: 'Comment' })).toHaveValue('rack 2');
  await expect(page.getByRole('button', { name: 'Delete Host' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Comment' }).fill('rack 3');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => patched).not.toBeNull();
  expect(patched).toEqual({ comment: 'rack 3', dry: true });
  expect(finds).toEqual(['web']);
});

test('an address block is picked for Delete only, without filling a Create', async ({ page }) => {
  await page.route('**/api/edit/address_block/find*', (r) =>
    r.fulfill({ json: { items: [{ id: 'ipam/address_block/3', label: '10.20.0.0/16', fields: { address: '10.20.0.0', cidr: 16, space: 'sp' } }] } }));
  await page.goto('/#editor?type=address_block');
  await page.getByPlaceholder('Find by address or comment').fill('10.20');
  await page.getByRole('button', { name: '10.20.0.0/16' }).click();
  await expect(page.getByRole('button', { name: 'Delete Address Block' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Address *' })).toHaveValue('');
});

test('while updating a zone, its name and view are read-only', async ({ page }) => {
  await page.route('**/api/edit/dns_zone/find*', (r) =>
    r.fulfill({ json: { items: [{ id: 'dns/auth_zone/1', label: 'lab.example.', fields: { fqdn: 'lab.example.', view: 'dns/view/1', comment: '' } }] } }));
  await page.goto('/#editor?type=dns_zone');
  await page.getByPlaceholder('Find by zone name or comment').fill('lab');
  await page.getByRole('button', { name: 'lab.example.' }).click();
  await expect(page.getByRole('textbox', { name: 'Zone name *' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Comment' })).toBeEnabled();
});

test('a Delete armed for one host is disarmed by picking another', async ({ page }) => {
  await page.route('**/api/edit/host/find*', (r) => r.fulfill({ json: { items: [
    { id: 'ipam/host/1', label: 'alpha', fields: { name: 'alpha', addresses: '10.0.0.1', comment: '' } },
    { id: 'ipam/host/2', label: 'beta', fields: { name: 'beta', addresses: '10.0.0.2', comment: '' } },
  ] } }));
  const deletes: string[] = [];
  await page.route('**/api/edit/host/*', (r) => {
    if (r.request().method() !== 'DELETE') return r.fallback();
    deletes.push(r.request().url());
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto('/#editor?type=host');
  await page.getByPlaceholder('Find by name or comment').fill('a');
  await page.getByRole('button', { name: 'alpha' }).click();
  await page.getByRole('button', { name: 'Delete Host' }).click();
  await expect(page.getByRole('button', { name: 'Click again to permanently delete' })).toBeVisible();
  await page.getByRole('button', { name: 'beta' }).click();
  // Straight away, well inside the 4 s the arm lasts: this click must only arm.
  await page.locator('button', { hasText: /Delete Host|Click again to permanently delete/ }).click();
  await page.waitForTimeout(300);
  expect(deletes).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Click again to permanently delete' })).toBeVisible();
});

test('each host address keeps its own IP space when the addresses change', async ({ page }) => {
  await page.route('**/api/edit/host/find*', (r) => r.fulfill({ json: { items: [
    { id: 'ipam/host/7', label: 'web7', fields: { name: 'web7', addresses: '10.0.0.7, 172.16.0.7', comment: '',
      spaces: '10.0.0.7=ipam/ip_space/9, 172.16.0.7=ipam/ip_space/4, 172.16.0.7=ipam/ip_space/5' } },
  ] } }));
  let patched: Record<string, unknown> | null = null;
  await page.route('**/api/edit/host/*', (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback();
    patched = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, dry_run: true, would_update: {} } });
  });
  await page.goto('/#editor?type=host');
  await page.getByPlaceholder('Find by name or comment').fill('web');
  await page.getByRole('button', { name: 'web7' }).click();
  // Drop 10.0.0.7 and add 10.0.0.8: the kept address keeps its space, and the
  // new one gets none, because this host's addresses sit in two spaces.
  await page.getByRole('textbox', { name: /Addresses/ }).fill('172.16.0.7, 10.0.0.8');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => patched).not.toBeNull();
  // 172.16.0.7 sits in two spaces, and keeps both.
  expect(patched).toEqual({ addresses: [
    { address: '172.16.0.7', space: 'ipam/ip_space/4' }, { address: '172.16.0.7', space: 'ipam/ip_space/5' },
    { address: '10.0.0.8' }], dry: true });
});

test('a second Update sends only what changed after the first', async ({ page }) => {
  await page.route('**/api/edit/host/find*', (r) => r.fulfill({ json: { items: [
    { id: 'ipam/host/7', label: 'web7', fields: { name: 'web7', addresses: '10.0.0.7', comment: 'rack 2' } },
  ] } }));
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/edit/host/*', (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback();
    const b = r.request().postDataJSON();
    bodies.push(b);
    return r.fulfill({ json: b.dry ? { ok: true, dry_run: true, would_update: {} } : { ok: true, message: 'Host updated.' } });
  });
  await page.goto('/#editor?type=host');
  await page.getByPlaceholder('Find by name or comment').fill('web');
  await page.getByRole('button', { name: 'web7' }).click();
  await page.getByRole('textbox', { name: 'Comment' }).fill('rack 3');
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByText('Host updated.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Name *' }).fill('web8');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).toEqual({ name: 'web8', dry: true });
});

test('results for an older search cannot be picked while a new one runs', async ({ page }) => {
  await page.route('**/api/edit/host/find*', async (r) => {
    const q = new URL(r.request().url()).searchParams.get('q');
    if (q === 'web') return r.fulfill({ json: { items: [{ id: 'ipam/host/7', label: 'web7', fields: { name: 'web7', addresses: '10.0.0.7', comment: '' } }] } });
    // The new search stays unanswered for the whole check.
    await new Promise((res) => setTimeout(res, 4000));
    return r.fulfill({ json: { items: [] } }).catch(() => {});
  });
  await page.goto('/#editor?type=host');
  const box = page.getByPlaceholder('Find by name or comment');
  await box.fill('web');
  await expect(page.getByRole('button', { name: 'web7' })).toBeVisible();
  await box.fill('db');
  await expect(page.getByRole('button', { name: 'web7' })).toHaveCount(0, { timeout: 1000 });
});

test('two results with the same label show their IDs', async ({ page }) => {
  await page.route('**/api/edit/subnet/find*', (r) => r.fulfill({ json: { items: [
    { id: 'ipam/subnet/a1', label: '10.0.0.0/24 — lab', fields: {} },
    { id: 'ipam/subnet/b2', label: '10.0.0.0/24 — lab', fields: {} },
  ] } }));
  await page.goto('/#editor?type=subnet');
  await page.getByRole('searchbox').fill('lab');
  await expect(page.getByRole('button', { name: '10.0.0.0/24 — lab ipam/subnet/a1' })).toBeVisible();
  await expect(page.getByRole('button', { name: '10.0.0.0/24 — lab ipam/subnet/b2' })).toBeVisible();
});
