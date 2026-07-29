import { test, expect } from './fixtures';

// SelfService.jsx's Allocate / DNS / Manage panels each fetch a picker list
// (/api/ipam/spaces, /api/dns/zones) via useApi(). A failed read leaves
// useApi's `data` null, and `data?.spaces ?? []` collapses that to the same
// empty array a genuinely empty tenant produces — so the panel rendered "no
// IP spaces" / "no DNS zones" whether the read failed or the inventory was
// actually empty. FetchError (already used elsewhere in this file, e.g. the
// Manage Records / Manage Addresses lists) reads `<api>.error` and must be
// wired into these pickers too. These specs stub each picker endpoint failing,
// then genuinely empty, and assert the wording differs.

const CARD_XPATH = 'xpath=ancestor::div[contains(@class,"bg-card")]';

test.describe('SelfService pickers — failed read vs genuine empty (IP spaces)', () => {
  test('a failed /api/ipam/spaces read shows a fetch-error, not "no IP spaces"', async ({ page }) => {
    await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));
    await page.route('**/api/dns/zones*', (route) => route.fulfill({ json: { zones: [] } }));

    await page.goto('/#selfservice');

    const allocateCard = page.locator('h2', { hasText: 'Allocate Address' }).locator(CARD_XPATH);
    await expect(allocateCard.getByText(/could not load current data/i)).toBeVisible();
    await expect(allocateCard.getByText('no IP spaces', { exact: true })).toHaveCount(0);

    const manageAddressesCard = page.locator('h2', { hasText: 'Manage Addresses' }).locator(CARD_XPATH);
    await expect(manageAddressesCard.getByText(/could not load current data/i)).toBeVisible();
    await expect(manageAddressesCard.getByText('no IP spaces', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/ipam/spaces read still shows "no IP spaces"', async ({ page }) => {
    await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ json: { spaces: [] } }));
    await page.route('**/api/dns/zones*', (route) => route.fulfill({ json: { zones: [] } }));

    await page.goto('/#selfservice');

    const allocateCard = page.locator('h2', { hasText: 'Allocate Address' }).locator(CARD_XPATH);
    await expect(allocateCard.getByText('no IP spaces', { exact: true })).toBeVisible();
    await expect(allocateCard.getByText(/could not load current data/i)).toHaveCount(0);

    const manageAddressesCard = page.locator('h2', { hasText: 'Manage Addresses' }).locator(CARD_XPATH);
    await expect(manageAddressesCard.getByText('no IP spaces', { exact: true })).toBeVisible();
    await expect(manageAddressesCard.getByText(/could not load current data/i)).toHaveCount(0);
  });
});

test.describe('SelfService pickers — failed read vs genuine empty (DNS zones)', () => {
  test('a failed /api/dns/zones read shows a fetch-error, not "no DNS zones"', async ({ page }) => {
    await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ json: { spaces: [] } }));
    await page.route('**/api/dns/zones*', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));

    await page.goto('/#selfservice');

    const dnsCard = page.locator('h2', { hasText: 'Create DNS Record' }).locator(CARD_XPATH);
    await expect(dnsCard.getByText(/could not load current data/i)).toBeVisible();
    await expect(dnsCard.getByText('no DNS zones', { exact: true })).toHaveCount(0);

    const manageRecordsCard = page.locator('h2', { hasText: 'Manage Records' }).locator(CARD_XPATH);
    await expect(manageRecordsCard.getByText(/could not load current data/i)).toBeVisible();
    await expect(manageRecordsCard.getByText('no DNS zones', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/dns/zones read still shows "no DNS zones"', async ({ page }) => {
    await page.route('**/api/ipam/spaces*', (route) => route.fulfill({ json: { spaces: [] } }));
    await page.route('**/api/dns/zones*', (route) => route.fulfill({ json: { zones: [] } }));

    await page.goto('/#selfservice');

    const dnsCard = page.locator('h2', { hasText: 'Create DNS Record' }).locator(CARD_XPATH);
    await expect(dnsCard.getByText('no DNS zones', { exact: true })).toBeVisible();
    await expect(dnsCard.getByText(/could not load current data/i)).toHaveCount(0);

    const manageRecordsCard = page.locator('h2', { hasText: 'Manage Records' }).locator(CARD_XPATH);
    await expect(manageRecordsCard.getByText('no DNS zones', { exact: true })).toBeVisible();
    await expect(manageRecordsCard.getByText(/could not load current data/i)).toHaveCount(0);
  });
});
