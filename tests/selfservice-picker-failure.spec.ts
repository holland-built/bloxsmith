import { test, expect } from './fixtures';
import { openTask } from './page-fixtures';

// SelfService.jsx's Allocate / DNS / Manage panels each fetch a picker list
// (/api/ipam/spaces, /api/dns/zones) via useApi(). A failed read leaves
// useApi's `data` null, and `data?.spaces ?? []` collapses that to the same
// empty array a genuinely empty tenant produces — so the panel rendered "no
// IP spaces" / "no DNS zones" whether the read failed or the inventory was
// actually empty. FetchError (already used elsewhere in this file, e.g. the
// Manage Records / Manage Addresses lists) reads `<api>.error` and must be
// wired into these pickers too. These specs stub each picker endpoint failing,
// then genuinely empty, and assert the wording differs.


test.describe('SelfService pickers — failed read vs genuine empty (IP spaces)', () => {
  test('a failed /api/ipam/spaces read shows a fetch-error, not "no IP spaces"', async ({ page }) => {
    await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));
    await page.route('**/api/dns/zones*', (route) => route.fulfill({ json: { zones: [] } }));

    await page.goto('/#selfservice');

    const allocateCard = await openTask(page, 'address');
    await expect(allocateCard.getByText(/could not load current data/i)).toBeVisible();
    await expect(allocateCard.getByText('no IP spaces', { exact: true })).toHaveCount(0);

    const manageAddressesCard = await openTask(page, 'addresses');
    await expect(manageAddressesCard.getByText(/could not load current data/i)).toBeVisible();
    await expect(manageAddressesCard.getByText('no IP spaces', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/ipam/spaces read still shows "no IP spaces"', async ({ page }) => {
    await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ json: { spaces: [] } }));
    await page.route('**/api/dns/zones*', (route) => route.fulfill({ json: { zones: [] } }));

    await page.goto('/#selfservice');

    const allocateCard = await openTask(page, 'address');
    await expect(allocateCard.getByText('no IP spaces', { exact: true })).toBeVisible();
    await expect(allocateCard.getByText(/could not load current data/i)).toHaveCount(0);

    const manageAddressesCard = await openTask(page, 'addresses');
    await expect(manageAddressesCard.getByText('no IP spaces', { exact: true })).toBeVisible();
    await expect(manageAddressesCard.getByText(/could not load current data/i)).toHaveCount(0);
  });
});

test.describe('SelfService pickers — failed read vs genuine empty (DNS zones)', () => {
  test('a failed /api/dns/zones read shows a fetch-error, not "no DNS zones"', async ({ page }) => {
    await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ json: { spaces: [] } }));
    await page.route('**/api/dns/zones*', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));

    await page.goto('/#selfservice');

    const dnsCard = await openTask(page, 'record');
    await expect(dnsCard.getByText(/could not load current data/i)).toBeVisible();
    await expect(dnsCard.getByText('no DNS zones', { exact: true })).toHaveCount(0);

    const manageRecordsCard = await openTask(page, 'records');
    await expect(manageRecordsCard.getByText(/could not load current data/i)).toBeVisible();
    await expect(manageRecordsCard.getByText('no DNS zones', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/dns/zones read still shows "no DNS zones"', async ({ page }) => {
    await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ json: { spaces: [] } }));
    await page.route('**/api/dns/zones*', (route) => route.fulfill({ json: { zones: [] } }));

    await page.goto('/#selfservice');

    const dnsCard = await openTask(page, 'record');
    await expect(dnsCard.getByText('no DNS zones', { exact: true })).toBeVisible();
    await expect(dnsCard.getByText(/could not load current data/i)).toHaveCount(0);

    const manageRecordsCard = await openTask(page, 'records');
    await expect(manageRecordsCard.getByText('no DNS zones', { exact: true })).toBeVisible();
    await expect(manageRecordsCard.getByText(/could not load current data/i)).toHaveCount(0);
  });
});
