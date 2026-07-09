import { test, expect } from '@playwright/test';

// Mocks /api/vault/status to drive the VaultGate decision tree deterministically.
// VaultGate (index.html): !vaultMode -> app shell; ready -> app shell;
// !exists -> setup; !unlocked -> unlock screen.

async function mockStatus(page, body) {
  await page.route('**/api/vault/status', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  );
}

test('locked vault shows passphrase unlock screen, no tab bar', async ({ page }) => {
  await mockStatus(page, { vaultMode: true, exists: true, unlocked: false });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock vault' })).toBeVisible();
  await expect(page.locator('#vu-pass')).toBeVisible();
  await expect(page.locator('.tabbar')).toHaveCount(0);
});

test('non-vault mode renders the app shell', async ({ page }) => {
  await mockStatus(page, { vaultMode: false });
  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.locator('.vault-screen')).toHaveCount(0);
});

test('no vault yet shows setup screen with min-8 passphrase field', async ({ page }) => {
  await mockStatus(page, { vaultMode: true, exists: false });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create your vault' })).toBeVisible();
  const pass = page.locator('#vs-pass');
  await expect(pass).toBeVisible();
  // min-8 enforcement: a short passphrase surfaces the validation error.
  await pass.fill('short');
  await page.locator('#vs-confirm').fill('short');
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.locator('.vault-err')).toContainText('at least 8');
});
