import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

// Covers ManageRecordsPanel + ManageAddressesPanel in ui/src/tabs/SelfService.jsx.
// Everything the panels fetch is stubbed via page.route() — no live tenant data,
// no real write ever leaves the browser. Selectors/copy are taken verbatim from
// that file (row markup around line 410-480, truncNote() at line 242, the
// held-snapshot guard in runApply() around line 322).

const ZONE = { id: 'zone1', fqdn: 'example.com' };
const SPACE = { id: 'space1', name: 'Default' };
const SUBNET = { id: 'subnet1', address: '10.0.0.0', cidr: 24, name: 'sub' };

function rowLocator(page: Page, rdata: string) {
  // COUPLED TO A UTILITY CLASS, and that is a known cost. The row has no test
  // id, so this is the only handle on it. `rounded-lg` became `rounded-control`
  // when the radius scale moved to role names, and these two locators are the
  // only place outside ui/src that had to move with it — ui/src/lib/
  // radiusRoles.test.js guards the source, not this file.
  return page.locator('.rounded-control.border.border-border.p-2').filter({ hasText: rdata });
}

async function stubZones(page: Page) {
  await page.route('**/api/dns/zones*', (route) => route.fulfill({ json: { zones: [ZONE] } }));
}

async function stubIpamPickers(page: Page) {
  await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ json: { spaces: [SPACE] } }));
  await page.route('**/api/ipam/subnets*', (route) => route.fulfill({ json: { subnets: [SUBNET] } }));
}

async function selectZone(page: Page) {
  const card = page.locator('h2', { hasText: 'Manage Records' }).locator('xpath=ancestor::div[contains(@class,"bg-card")]');
  await card.locator('select').selectOption(ZONE.id);
}

async function selectSpaceAndSubnet(page: Page) {
  const card = page.locator('h2', { hasText: 'Manage Addresses' }).locator('xpath=ancestor::div[contains(@class,"bg-card")]');
  await card.locator('select').first().selectOption(SPACE.id);
  await card.locator('select').nth(1).selectOption(SUBNET.id);
}

test.describe('ManageRecordsPanel', () => {
  test('read-only record types get no Edit/Delete controls (D2)', async ({ page }) => {
    await stubZones(page);
    await stubIpamPickers(page);
    const soa = { id: 'rec-soa', type: 'SOA', name_in_zone: '@', ttl: 3600, dns_rdata: 'ns1.example.com. admin.example.com. 1 2 3 4 5', comment: '' };
    const a = { id: 'rec-a', type: 'A', name_in_zone: 'www', ttl: 300, dns_rdata: '192.0.2.10', comment: 'web' };
    await page.route('**/api/dns/records*', (route) => route.fulfill({ json: { records: [soa, a] } }));

    await page.goto('/#selfservice');
    await selectZone(page);

    const soaRow = rowLocator(page, soa.dns_rdata);
    await expect(soaRow.getByText('read-only type')).toBeVisible();
    await expect(soaRow.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(soaRow.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    const aRow = rowLocator(page, a.dns_rdata);
    await expect(aRow.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(aRow.getByRole('button', { name: 'Delete' })).toBeVisible();
  });

  test('truncation note shown for {truncated:true}', async ({ page }) => {
    await stubZones(page);
    await stubIpamPickers(page);
    const recs = [
      { id: 'r1', type: 'A', name_in_zone: 'a1', ttl: 300, dns_rdata: '192.0.2.1', comment: '' },
      { id: 'r2', type: 'A', name_in_zone: 'a2', ttl: 300, dns_rdata: '192.0.2.2', comment: '' },
    ];
    await page.route('**/api/dns/records*', (route) => route.fulfill({ json: { records: recs, limit: 2, truncated: true } }));

    await page.goto('/#selfservice');
    await selectZone(page);

    await expect(page.getByText('showing first 2 — more may exist')).toBeVisible();
  });

  test('shows "showing N of M" note when total is present', async ({ page }) => {
    await stubZones(page);
    await stubIpamPickers(page);
    const recs = [
      { id: 'r1', type: 'A', name_in_zone: 'a1', ttl: 300, dns_rdata: '192.0.2.1', comment: '' },
      { id: 'r2', type: 'A', name_in_zone: 'a2', ttl: 300, dns_rdata: '192.0.2.2', comment: '' },
      { id: 'r3', type: 'A', name_in_zone: 'a3', ttl: 300, dns_rdata: '192.0.2.3', comment: '' },
    ];
    await page.route('**/api/dns/records*', (route) => route.fulfill({ json: { records: recs, limit: 200, total: 5 } }));

    await page.goto('/#selfservice');
    await selectZone(page);

    await expect(page.getByText('showing 3 of 5')).toBeVisible();
  });

  test('no truncation note when data carries neither field', async ({ page }) => {
    await stubZones(page);
    await stubIpamPickers(page);
    const recs = [{ id: 'r1', type: 'A', name_in_zone: 'a1', ttl: 300, dns_rdata: '192.0.2.1', comment: '' }];
    await page.route('**/api/dns/records*', (route) => route.fulfill({ json: { records: recs } }));

    await page.goto('/#selfservice');
    await selectZone(page);

    await expect(rowLocator(page, '192.0.2.1')).toBeVisible();
    await expect(page.getByText(/showing/i)).toHaveCount(0);
  });

  test('held snapshot: Preview and Apply carry identical `expected`, id in body not URL', async ({ page }) => {
    await stubZones(page);
    await stubIpamPickers(page);
    const original = { id: 'rec-a', type: 'A', name_in_zone: 'www', ttl: 300, dns_rdata: '192.0.2.10', comment: 'web' };
    const patchBodies: any[] = [];
    const patchUrls: string[] = [];

    await page.route('**/api/dns/records*', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({ json: { records: [original] } });
      }
      if (req.method() === 'PATCH') {
        patchUrls.push(req.url());
        const body = JSON.parse(req.postData() || '{}');
        patchBodies.push(body);
        return route.fulfill({ json: { would_update: { ...body } } });
      }
      return route.continue();
    });

    await page.goto('/#selfservice');
    await selectZone(page);

    const row = rowLocator(page, original.dns_rdata);
    await row.getByRole('button', { name: 'Edit' }).click();
    const valueInput = row.locator('input').first();
    await valueInput.fill('203.0.113.5');
    await row.getByRole('button', { name: 'Preview' }).click();

    await expect.poll(() => patchBodies.length).toBe(1);
    expect(patchBodies[0].dry).toBe(true);
    expect(patchBodies[0].id).toBe('rec-a');
    expect(patchUrls[0]).not.toContain('rec-a'); // id travels in the body, never the URL
    expect(new URL(patchUrls[0]).pathname).toBe('/api/dns/records');
    expect(patchBodies[0].expected).toEqual({ value: '192.0.2.10', ttl: 300, comment: 'web' });

    await row.getByRole('button', { name: 'Update' }).click();

    await expect.poll(() => patchBodies.length).toBe(2);
    expect(patchBodies[1].dry).toBe(false);
    expect(patchUrls[1]).not.toContain('rec-a');
    // Core guard: Apply must reuse the exact snapshot Preview held, never a
    // freshly re-read one, even though value/ttl/comment moved on to the edit.
    expect(patchBodies[1].expected).toEqual(patchBodies[0].expected);
    expect(patchBodies[1].expected).toEqual({ value: '192.0.2.10', ttl: 300, comment: 'web' });

    // Apply success closes the edit row (setEditingId(null) fires in the same
    // tick), and the confirmation now lives at panel level so it survives
    // that unmount instead of dying with the row.
    await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Update' })).toHaveCount(0);
    await expect(page.getByText('DNS record updated.')).toBeVisible();
  });

  test('409 conflict from Apply surfaces the error and leaves the row unchanged', async ({ page }) => {
    await stubZones(page);
    await stubIpamPickers(page);
    const original = { id: 'rec-a', type: 'A', name_in_zone: 'www', ttl: 300, dns_rdata: '192.0.2.10', comment: 'web' };
    const conflictMsg = 'record changed since it was read — re-fetch and retry';

    await page.route('**/api/dns/records*', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({ json: { records: [original] } });
      }
      if (req.method() === 'PATCH') {
        const body = JSON.parse(req.postData() || '{}');
        if (body.dry === true) {
          return route.fulfill({ json: { would_update: { ...body } } });
        }
        return route.fulfill({ status: 409, json: { error: conflictMsg, current: { ...original, dns_rdata: '198.51.100.9' } } });
      }
      return route.continue();
    });

    await page.goto('/#selfservice');
    await selectZone(page);

    const row = rowLocator(page, original.dns_rdata);
    await row.getByRole('button', { name: 'Edit' }).click();
    await row.locator('input').first().fill('203.0.113.5');
    await row.getByRole('button', { name: 'Preview' }).click();
    await expect(row.getByRole('button', { name: 'Update' })).toBeVisible();
    await row.getByRole('button', { name: 'Update' }).click();

    await expect(page.getByText(conflictMsg)).toBeVisible();
    // Nothing was committed: the row's displayed value is still the original.
    await expect(rowLocator(page, original.dns_rdata)).toBeVisible();
    await expect(rowLocator(page, '198.51.100.9')).toHaveCount(0);
  });

  test('two-click delete arm: first click only arms, second click fires exactly one DELETE', async ({ page }) => {
    await stubZones(page);
    await stubIpamPickers(page);
    const rec = { id: 'rec-del', type: 'A', name_in_zone: 'www', ttl: 300, dns_rdata: '192.0.2.10', comment: '' };
    const deletes: string[] = [];

    await page.route('**/api/dns/records*', (route) => route.fulfill({ json: { records: [rec] } }));
    await page.route('**/api/dns/records/*', (route) => {
      deletes.push(route.request().url());
      // already_gone is set EXPLICITLY on both of edit.Client.Delete's success
      // arms (go/internal/edit/resources.go:445) — false for a real 200/204,
      // true for a 404. This stub predated the field and its absence now means
      // UNKNOWN, which the UI must not render as a confirmed deletion.
      return route.fulfill({ json: { ok: true, already_gone: false } });
    });

    await page.goto('/#selfservice');
    await selectZone(page);

    const row = rowLocator(page, rec.dns_rdata);
    await row.getByRole('button', { name: 'Delete' }).click();

    await expect(row.getByRole('button', { name: 'Confirm delete' })).toBeVisible();
    await expect(row.getByText(`Click again to delete A www -> ${rec.dns_rdata}`)).toBeVisible();
    expect(deletes).toHaveLength(0);

    await row.getByRole('button', { name: 'Confirm delete' }).click();

    await expect.poll(() => deletes.length).toBe(1);
    expect(deletes[0]).toContain(`/api/dns/records/${encodeURIComponent(rec.id)}`);
    await expect(page.getByText('DNS record deleted.')).toBeVisible();
  });

  test('delete arm auto-disarms after 4s with no DELETE ever fired', async ({ page }) => {
    await stubZones(page);
    await stubIpamPickers(page);
    const rec = { id: 'rec-del2', type: 'A', name_in_zone: 'www', ttl: 300, dns_rdata: '192.0.2.11', comment: '' };
    const deletes: string[] = [];

    await page.route('**/api/dns/records*', (route) => route.fulfill({ json: { records: [rec] } }));
    await page.route('**/api/dns/records/*', (route) => {
      deletes.push(route.request().url());
      // already_gone is set EXPLICITLY on both of edit.Client.Delete's success
      // arms (go/internal/edit/resources.go:445) — false for a real 200/204,
      // true for a 404. This stub predated the field and its absence now means
      // UNKNOWN, which the UI must not render as a confirmed deletion.
      return route.fulfill({ json: { ok: true, already_gone: false } });
    });

    await page.goto('/#selfservice');
    await selectZone(page);

    const row = rowLocator(page, rec.dns_rdata);
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row.getByRole('button', { name: 'Confirm delete' })).toBeVisible();

    await page.waitForTimeout(4300); // legitimately needs a real wait past the 4000ms auto-disarm timer

    await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible();
    expect(deletes).toHaveLength(0);
  });
});

test.describe('ManageAddressesPanel', () => {
  test('two-click release: DELETE hits /api/ipam/addresses/<id> URL-encoded', async ({ page }) => {
    await stubIpamPickers(page);
    const addr = { id: 'ipam/address/1', address: '10.0.0.5', state: 'used', name: 'host-1', comment: '' };
    const deletes: string[] = [];

    await page.route('**/api/ipam/addresses*', (route) => route.fulfill({ json: { addresses: [addr] } }));
    await page.route('**/api/ipam/addresses/*', (route) => {
      deletes.push(route.request().url());
      // already_gone is set EXPLICITLY on both of edit.Client.Delete's success
      // arms (go/internal/edit/resources.go:445) — false for a real 200/204,
      // true for a 404. This stub predated the field and its absence now means
      // UNKNOWN, which the UI must not render as a confirmed deletion.
      return route.fulfill({ json: { ok: true, already_gone: false } });
    });

    await page.goto('/#selfservice');
    await selectSpaceAndSubnet(page);

    const card = page.locator('h2', { hasText: 'Manage Addresses' }).locator('xpath=ancestor::div[contains(@class,"bg-card")]');
    const row = card.locator('.rounded-control.border.border-border.p-2').filter({ hasText: addr.address });

    await row.getByRole('button', { name: 'Release' }).click();
    await expect(row.getByRole('button', { name: 'Confirm release' })).toBeVisible();
    expect(deletes).toHaveLength(0);

    await row.getByRole('button', { name: 'Confirm release' }).click();

    await expect.poll(() => deletes.length).toBe(1);
    expect(deletes[0]).toContain(`/api/ipam/addresses/${encodeURIComponent(addr.id)}`);
    expect(deletes[0]).toContain('%2F');
  });
});
