import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// A read-only tenant refuses every Apply before it starts, and EventSource
// cannot read why. The page used to show only "Stream connection error". It now
// says the tenant is read-only up front, offers the switch (admin only, with a
// confirm step), lets Preview run (it changes nothing), and never opens an
// Apply stream it knows will be refused.

const READ_ONLY = { known: true, tenant: 'baseline-tenant/-', label: 'Baseline Tenant', writable: false };
const WRITABLE = { ...READ_ONLY, writable: true };

function json(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('on a read-only tenant Preview runs, and Apply says why instead of opening a stream', async ({ page }) => {
  await page.route('**/api/vault/write-target*', (route) => json(route, READ_ONLY));
  const seen: string[] = [];
  await page.route('**/api/provision/seed-demo/stream*', (route) => {
    seen.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ done: true, succeeded: 1, failed: 0, skipped: 0 })}\n\n` });
  });
  await page.goto('/#provision');
  await expect(page.getByText('Baseline Tenant is read-only.')).toBeVisible();

  await page.getByRole('button', { name: 'Seed demo', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Seed demo data', exact: true })).toBeVisible();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain('dry=1');

  await page.getByRole('button', { name: 'Seed demo data', exact: true }).click();
  await expect(page.getByText(/Baseline Tenant is read-only, so nothing was sent/)).toBeVisible();
  await expect(page.getByText('Stream connection error')).toHaveCount(0);
  expect(seen).toHaveLength(1); // no apply stream was opened
});

test('an admin switches the tenant to read-write after a confirm step, and the notice goes away', async ({ page }) => {
  let writable = false;
  const posted: unknown[] = [];
  await page.route('**/api/vault/write-target*', (route) => json(route, writable ? WRITABLE : READ_ONLY));
  await page.route('**/api/vault/tenant-writable', async (route) => {
    posted.push(route.request().postDataJSON());
    writable = true;
    return json(route, { ok: true });
  });
  await page.goto('/#provision');

  await page.getByRole('button', { name: 'Switch to read-write' }).click();
  // Nothing is sent until the operator confirms.
  expect(posted).toEqual([]);
  await expect(page.getByText(/create and delete real DNS zones, subnets, address blocks, DHCP ranges and\s+host records in Baseline Tenant/)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, allow changes' }).click();

  // The tenant named on screen is the one sent, so a tenant switch in another
  // tab cannot turn this into a grant for a different tenant.
  expect(posted).toEqual([{ writable: true, id: 'baseline-tenant/-' }]);
  await expect(page.getByText('Baseline Tenant is read-only.')).toHaveCount(0);
});

test('Cancel leaves the tenant read-only and sends nothing', async ({ page }) => {
  const posted: unknown[] = [];
  await page.route('**/api/vault/write-target*', (route) => json(route, READ_ONLY));
  await page.route('**/api/vault/tenant-writable', (route) => { posted.push(1); return json(route, { ok: true }); });
  await page.goto('/#provision');

  await page.getByRole('button', { name: 'Switch to read-write' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(posted).toEqual([]);
  await expect(page.getByText('Baseline Tenant is read-only.')).toBeVisible();
});

test('a refused switch says why', async ({ page }) => {
  await page.route('**/api/vault/write-target*', (route) => json(route, READ_ONLY));
  await page.route('**/api/vault/tenant-writable', (route) => json(route, { ok: false, error: 'admin required' }, 403));
  await page.goto('/#provision');

  await page.getByRole('button', { name: 'Switch to read-write' }).click();
  await page.getByRole('button', { name: 'Yes, allow changes' }).click();
  await expect(page.getByText('admin required')).toBeVisible();
  await expect(page.getByText('Baseline Tenant is read-only.')).toBeVisible();
});

test('a non-admin is told who can switch it, and gets no switch', async ({ page }) => {
  await page.route('**/api/vault/write-target*', (route) => json(route, READ_ONLY));
  await page.route('**/api/whoami*', (route) => json(route, { actor: 'baseline-viewer', role: 'viewer', tenant: 'baseline-tenant', token_auth: false }));
  await page.goto('/#provision');

  await expect(page.getByText('Baseline Tenant is read-only.')).toBeVisible();
  await expect(page.getByText('An admin can switch it to read-write in Settings.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch to read-write' })).toHaveCount(0);
});

test('a writable tenant shows no notice', async ({ page }) => {
  await page.goto('/#provision');
  await expect(page.getByText(/is read-only/)).toHaveCount(0);
});
