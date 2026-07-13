import { test, expect } from '@playwright/test';

// Global design-consistency pass — each of the 4 functional tabs now mounts the
// shared PageHeader primitive (.page-head) with its own title, matching the
// redesigned Overview. This asserts the header renders per tab and that the
// tab's primary control is present (i.e. the skin pass didn't break the mount).
//
// Only the vault gate + backend APIs are mocked: the app's useApi/useData
// fallbacks turn empty ({}) payloads into empty lists, so every tab renders its
// chrome (header, mode switcher, form) without a live backend.

async function stubBackend(page) {
  // Catch-all first; the vault-status override registered after it wins.
  await page.route('**/api/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  await page.route('**/api/vault/status', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ vaultMode: false }) })
  );
}

async function gotoTab(page, hash) {
  await stubBackend(page);
  await page.goto('/#' + hash, { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

test('Self-Service renders its PageHeader + Allocate form', async ({ page }) => {
  await gotoTab(page, 'selfservice');
  await expect(page.locator('.page-head .page-title', { hasText: 'Self-Service' })).toBeVisible();
  await expect(page.locator('.dly-seg-btn', { hasText: 'Allocate' })).toBeVisible();
  await expect(page.locator('.vault-in').first()).toBeVisible();
});

test('Provision renders its PageHeader + request form fields', async ({ page }) => {
  await gotoTab(page, 'provision');
  await expect(page.locator('.page-head .page-title', { hasText: 'Provision' })).toBeVisible();
  await expect(page.locator('.dly-seg-btn', { hasText: 'Subnet' })).toBeVisible();
  await expect(page.locator('.vault-in').first()).toBeVisible();
});

test('Editor renders its PageHeader + resource-type switcher', async ({ page }) => {
  await gotoTab(page, 'editor');
  await expect(page.locator('.page-head .page-title', { hasText: 'Editor' }).first()).toBeVisible();
  await expect(page.locator('.dly-seg-btn', { hasText: 'DNS Record' }).first()).toBeVisible();
});

test('Drift renders its PageHeader + Check drift button', async ({ page }) => {
  await gotoTab(page, 'drift');
  await expect(page.locator('.page-head .page-title', { hasText: 'Drift' })).toBeVisible();
  await expect(page.locator('button', { hasText: 'Check drift' })).toBeVisible();
});
