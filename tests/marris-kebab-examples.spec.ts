import { test, expect } from '@playwright/test';

// Marris-tabs consistency (P2 slice 8): a shared KebabMenu (⋮) consolidates
// SECONDARY actions (example loaders, copy/reset utilities) while PRIMARY and
// DESTRUCTIVE actions stay visible + labeled, and "Load/Try example" affordances
// prefill forms or sample-render illustrative data (never auto-submit / mutate).
// All /api calls are mocked so the tabs render without a live backend.

async function stubBackend(page) {
  await page.route('**/api/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/vault/status', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ vaultMode: false }) }));
  await page.route('**/api/whoami', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ role: 'admin' }) }));
  await page.route('**/api/templates', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ name: 'london', region: 'EMEA', environment: 'production', type: 'site' }]) }));
  await page.route('**/api/dns/zones', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ zones: [{ id: 'z1', fqdn: 'corp.example.com' }] }) }));
  await page.route('**/api/ipam/spaces', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ spaces: [{ id: 's1', name: 'default' }] }) }));
}

async function gotoTab(page, hash) {
  await stubBackend(page);
  await page.goto('/#' + hash, { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

test('KebabMenu — keyboard open/close, groups secondary actions, destructive stays visible+labeled', async ({ page }) => {
  await gotoTab(page, 'provision');
  // Full site mode has the destructive "Tear down this site" action.
  await page.locator('.dly-seg-btn', { hasText: 'Full site' }).click();

  // Destructive action stays a visible, labeled button — NOT buried in the kebab.
  await expect(page.locator('button', { hasText: 'Tear down this site' })).toBeVisible();

  const kebab = page.locator('.kebab-btn').first();
  await expect(kebab).toBeVisible();
  await expect(kebab).toHaveAttribute('aria-expanded', 'false');

  // Keyboard-openable: focus the button and press Enter.
  await kebab.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('.kebab-menu[role="menu"]');
  await expect(menu).toBeVisible();
  await expect(kebab).toHaveAttribute('aria-expanded', 'true');

  // Secondary action grouped inside the kebab as a menuitem.
  await expect(menu.locator('[role="menuitem"]', { hasText: 'Load site example' })).toBeVisible();

  // Esc closes and returns focus to the trigger (focus-managed).
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(kebab).toBeFocused();
});

test('Provision — "Load example" prefills the subnet form with site-template values (no submit)', async ({ page }) => {
  await gotoTab(page, 'provision');
  // Subnet mode (default) — real editable form.
  await page.locator('.kebab-btn').first().click();
  await page.locator('.kebab-menu [role="menuitem"]', { hasText: 'Load example' }).click();

  // Form prefilled from the london site template (illustrative values only).
  const name = page.locator('label.field-lbl', { hasText: 'Name' }).locator('input');
  await expect(name).toHaveValue(/london/i);
  const cidr = page.locator('label.field-lbl', { hasText: 'CIDR' }).locator('input');
  await expect(cidr).toHaveValue('24');

  // A clearly-labeled "Example" sample panel teaches the tab (site template detail).
  const ex = page.locator('.marris-example').first();
  await expect(ex).toBeVisible();
  await expect(ex).toContainText(/Example/);
  await expect(page.getByText('internal.example.com').first()).toBeVisible();
});

test('Drift — shows an example glyph-diff result clearly labeled Example', async ({ page }) => {
  await gotoTab(page, 'drift');
  await page.locator('.kebab-btn').first().click();
  await page.locator('.kebab-menu [role="menuitem"]', { hasText: 'example' }).click();

  const ex = page.locator('.marris-example').first();
  await expect(ex).toBeVisible();
  await expect(ex).toContainText(/Example/);

  // Rendered in the shared glyph-diff vocabulary (=/~/−) with text labels, not color-only.
  const glyphs = ex.locator('table.dt td.dt-diff');
  await expect(glyphs).toHaveCount(4);
  const marks = (await glyphs.allInnerTexts()).map(s => s.trim());
  expect(marks).toContain('=');   // in sync
  expect(marks).toContain('~');   // changed
  expect(marks).toContain('−');   // missing
  await expect(ex.locator('table.dt td.dt-diff span[aria-label]').first()).toBeVisible();
});

test('Self-Service — "Try example" prefills the allocate form (no submit)', async ({ page }) => {
  await gotoTab(page, 'selfservice');
  // Allocate mode (default).
  await page.locator('.kebab-btn').first().click();
  await page.locator('.kebab-menu [role="menuitem"]', { hasText: 'example' }).click();

  await expect(page.getByRole('textbox', { name: 'Tag key', exact: true })).toHaveValue('environment');
  await expect(page.getByRole('textbox', { name: 'Tag value', exact: true })).toHaveValue('prod');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(/example/i);
});
