import { test, expect } from './fixtures';

// First-run vault setup ("Add your first connection" / FirstTenant screen)
// is what VaultGate renders when vaultMode + exists + unlocked are all true
// but ready is false — no tenant saved yet.
async function gotoFirstTenant(page) {
  await page.route('**/api/vault/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vaultMode: true, exists: true, unlocked: true, ready: false, tenants: [] }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Add your first connection' })).toBeVisible();
}

// A transport failure (offline/VPN/proxy/timeout) means the key was never
// judged — vault/manage.go's unverifiable() sets {ok:false, unverified:true}
// for exactly this case. The UI must render neutral "could not verify" copy,
// never the red "rejected"/"Invalid" styling that implies the key is bad.
test('unverified test-key result shows neutral copy, not rejected', async ({ page }) => {
  await gotoFirstTenant(page);
  await page.route('**/api/vault/test-key', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        unverified: true,
        error: 'could not reach Infoblox CSP: dial tcp: i/o timeout',
      }),
    }),
  );

  await page.fill('#vat-key', 'some-token');
  await page.getByRole('button', { name: 'Test key' }).click();

  await expect(page.getByText(/could not verify/i)).toBeVisible();
  await expect(page.getByText(/rejected/i)).toHaveCount(0);
  await expect(page.getByText(/^Invalid:/)).toHaveCount(0);
});

// ok:false WITHOUT unverified is a real, CSP-confirmed rejection — the
// existing "Invalid: ... rejected" copy must still show exactly as before.
test('rejected (non-unverified) test-key result still shows rejected copy', async ({ page }) => {
  await gotoFirstTenant(page);
  await page.route('**/api/vault/test-key', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'key rejected by Infoblox CSP' }),
    }),
  );

  await page.fill('#vat-key', 'some-token');
  await page.getByRole('button', { name: 'Test key' }).click();

  await expect(page.getByText(/Invalid: key rejected by Infoblox CSP/i)).toBeVisible();
});

// ok:true is unaffected by the unverified change.
test('valid test-key result shows success', async ({ page }) => {
  await gotoFirstTenant(page);
  await page.route('**/api/vault/test-key', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, name: 'Acme Corp' }),
    }),
  );

  await page.fill('#vat-key', 'some-token');
  await page.getByRole('button', { name: 'Test key' }).click();

  await expect(page.getByText(/Key valid — Acme Corp/i)).toBeVisible();
});
