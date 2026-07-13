import { test, expect } from '@playwright/test';

// Marris provisioning tabs (Drift / Self-Service / Provision) — CONTENT reskin
// to the app's shared design primitives. Presentation only: no behavior change.
//  - Drift result renders the shared glyph-diff pattern (+ / − / ~) with text,
//    NOT a color-only severity list (no-color-only law, identical both themes).
//  - Self-Service tabular panels render the shared DataTable (table.dt with a
//    sortable header), not hand-rolled rows.
//  - Provision sections are wrapped in the shared Panel / .pcard.
// Every /api call is mocked so the tabs render without a live backend.

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
      body: JSON.stringify([{ name: 'demo-site', region: 'AMER', environment: 'prod', type: 'site' }]) }));
}

// Playwright matches routes last-registered-first, so per-test overrides must be
// registered AFTER the catch-all stub to win. `overrides` runs after stubBackend.
async function gotoTab(page, hash, overrides?) {
  await stubBackend(page);
  if (overrides) await overrides(page);
  await page.goto('/#' + hash, { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

test('Drift — result renders shared glyph-diff markers (+/−/~) with text, not color-only', async ({ page }) => {
  await gotoTab(page, 'drift', p => p.route('**/api/drift/check', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      site: 'demo-site', found: true, drifted: true, subnet_count: 3,
      drifts: [
        { category: 'subnet', severity: 'error',   field: 'subnet:a', message: "Expected subnet 'a' not found in API" },
        { category: 'subnet', severity: 'warning', field: 'subnet:b', message: "Subnet 'b' exists in API but is not in the template" },
        { category: 'tags',   severity: 'warning', field: 'tags.env', message: "Tag 'env': expected 'prod', live value is 'dev'" },
      ],
      summary: { total: 3, errors: 1, warnings: 2 },
    }) })));
  await expect(page.locator('.page-title', { hasText: 'Drift' })).toBeVisible();
  await page.locator('label.field-lbl', { hasText: 'Template' }).first().locator('select').selectOption('demo-site');
  await page.locator('button', { hasText: 'Check drift' }).first().click();

  // Shared glyph-diff column renders one glyph cell per drift item.
  const glyphs = page.locator('table.dt td.dt-diff');
  await expect(glyphs).toHaveCount(3);
  const marks = (await glyphs.allInnerTexts()).map(s => s.trim());
  expect(marks).toContain('+');   // only-in-template
  expect(marks).toContain('−');   // only-in-live
  expect(marks).toContain('~');   // changed

  // Each glyph carries an accessible text label (not color-only).
  await expect(page.locator('table.dt td.dt-diff span[aria-label]').first()).toBeVisible();
  // The drift message text is rendered alongside the glyph.
  await expect(page.locator('table.dt', { hasText: 'not found in API' })).toBeVisible();
});

test('Self-Service — tabular DNS-records panel renders a shared DataTable (table.dt)', async ({ page }) => {
  await gotoTab(page, 'selfservice', async p => {
    await p.route('**/api/dns/zones', route =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ zones: [{ id: 'z1', fqdn: 'example.com.' }] }) }));
    await p.route('**/api/dns/records**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { id: 'r1', name_in_zone: 'web', type: 'A', ttl: 300, dns_rdata: '10.0.0.5', comment: '', disabled: false },
        { id: 'r2', name_in_zone: 'mail', type: 'A', ttl: 300, dns_rdata: '10.0.0.6', comment: '', disabled: false },
      ]) }));
  });
  await expect(page.locator('.page-title', { hasText: 'Self-Service' })).toBeVisible();
  await page.locator('.dly-seg-btn', { hasText: 'DNS Records' }).click();
  await page.locator('label.field-lbl', { hasText: 'Zone' }).first().locator('select').selectOption('z1');

  // DataTable renders a real table.dt with a sortable header (hand-rolled lists have neither).
  await expect(page.locator('table.dt thead th').first()).toBeVisible();
  await expect(page.locator('table.dt tbody tr', { hasText: 'web' })).toBeVisible();
  // Inline row actions survive (Edit / Delete rendered as row-action buttons).
  await expect(page.locator('table.dt button', { hasText: 'Edit' }).first()).toBeVisible();
});

test('Provision — form + streaming-log sections use the shared Panel / .pcard', async ({ page }) => {
  await gotoTab(page, 'provision');
  await expect(page.locator('.page-title', { hasText: 'Provision' })).toBeVisible();
  // Request form and Live log are both .pcard panels.
  await expect(page.locator('.pcard', { hasText: 'Request' }).first()).toBeVisible();
  await expect(page.locator('.pcard h3 span', { hasText: 'Live log' }).last()).toBeVisible();
  // Mode controls use the shared segmented-control primitive.
  await expect(page.locator('.dly-seg-btn', { hasText: 'Subnet' })).toBeVisible();
});
