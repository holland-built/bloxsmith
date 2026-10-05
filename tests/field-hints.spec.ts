import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// A box that holds an address, a host name or a filter tells the browser so:
// no spell-check, no autofill history, no auto-capitalising. A box that holds
// prose says nothing and keeps its spell-check.
//
// ui/src/lib/machineText.test.js reads the source and holds the full list of
// which box is which. This is the other half: that the attributes written in
// the source reach the element a person types in.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('a filter box is marked as machine text', async ({ page }) => {
  await page.goto('/#overview');
  const filter = page.getByLabel('Filter subnets');
  await expect(filter).toBeVisible({ timeout: 20_000 });
  await expect(filter).toHaveAttribute('spellcheck', 'false');
  await expect(filter).toHaveAttribute('autocomplete', 'off');
  await expect(filter).toHaveAttribute('autocapitalize', 'none');
});

test('a form box for a name is machine text, and the comment box beside it is not', async ({ page }) => {
  await page.goto('/#provision');
  const name = page.getByPlaceholder('subnet name');
  await expect(name).toBeVisible({ timeout: 20_000 });
  await expect(name).toHaveAttribute('spellcheck', 'false');
  await expect(name).toHaveAttribute('autocomplete', 'off');

  // The comment is prose: a browser's spell-check is the point there.
  const comment = page.getByPlaceholder('optional');
  await expect(comment).toBeVisible();
  expect(await comment.getAttribute('spellcheck')).toBeNull();
  expect(await comment.getAttribute('autocomplete')).toBeNull();
});

// ---------------------------------------------------------------------------
// The boxes that hold a secret say which kind they are (ui/src/lib/secretBox.js).
//
// A vault passphrase may be saved and filled by a password manager, so its boxes
// say new-password (creating the vault, confirming it) or current-password
// (unlocking it). An API key or a token is pasted, not typed, and is not a
// login, so its box asks every manager to stay out. The unit test reads the
// source; these check what the browser ends up holding.
// ---------------------------------------------------------------------------

const vaultStatus = (page: import('@playwright/test').Page, body: Record<string, unknown>) =>
  page.route('**/api/vault/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vaultMode: true, exists: true, unlocked: true, ready: false, tenants: [], ...body }),
    }),
  );

const staysOut = async (box: import('@playwright/test').Locator) => {
  await expect(box).toHaveAttribute('autocomplete', 'off');
  await expect(box).toHaveAttribute('data-1p-ignore', 'true');
  await expect(box).toHaveAttribute('data-lpignore', 'true');
  await expect(box).toHaveAttribute('data-bwignore', 'true');
};

test('creating the vault: both passphrase boxes tell a password manager they are a new password', async ({ page }) => {
  await vaultStatus(page, { exists: false, unlocked: false });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create your vault' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#vs-pass')).toHaveAttribute('autocomplete', 'new-password');
  await expect(page.locator('#vs-confirm')).toHaveAttribute('autocomplete', 'new-password');
});

test('unlocking the vault: the passphrase box tells a password manager it is the current password', async ({ page }) => {
  await vaultStatus(page, { unlocked: false });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock vault' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#vu-pass')).toHaveAttribute('autocomplete', 'current-password');
});

test('adding the first connection: both key boxes ask a password manager to stay out', async ({ page }) => {
  await vaultStatus(page, {});
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Add your first connection' })).toBeVisible({ timeout: 20_000 });
  await staysOut(page.locator('#vat-key'));
  await staysOut(page.locator('#vat-groq'));
});

test('in Settings, the add and change key boxes, the integration key and the dashboard token all ask a password manager to stay out', async ({ page }) => {
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 20_000 });
  // Present in the page whether or not their section is showing.
  await staysOut(page.locator('#tm-axur-key'));
  await staysOut(page.locator('#tm-dash-token'));
  // The change-key form opens on a click, for the one connection the fixture has.
  await page.getByRole('button', { name: 'Change key for Baseline Tenant' }).click();
  await staysOut(page.locator('#tm-edit-key'));
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  // And so does the add form.
  await page.getByRole('button', { name: '+ Add connection' }).click();
  await staysOut(page.locator('#tm-add-key'));
  await staysOut(page.locator('#tm-add-groq'));
});
