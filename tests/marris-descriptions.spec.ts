import { test, expect } from '@playwright/test';

// Marris provisioning tabs (Provision / Drift / Self-Service) now carry
// plain-English hover descriptions via the shared useHoverDetail() popup
// (.hoverdetail element) — NOT native title= attributes. Each test mocks
// the backend so the tab renders, hovers a key control, and asserts the
// hover-detail popup shows the expected explanatory text.
//
// The popup is a single shared element (.hoverdetail) mounted once in the
// Shell; showing it adds the `.show` class and rewrites innerHTML.

async function stubBackend(page) {
  await page.route('**/api/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  await page.route('**/api/vault/status', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ vaultMode: false }) })
  );
  await page.route('**/api/whoami', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ role: 'admin' }) })
  );
  await page.route('**/api/templates', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ name: 'demo-site', region: 'AMER', environment: 'prod', type: 'site' }]) })
  );
}

async function gotoTab(page, hash) {
  await stubBackend(page);
  await page.goto('/#' + hash, { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

// Hover the given element and return the visible hover-detail popup's text.
async function hoverText(page, target) {
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  const pop = page.locator('.hoverdetail.show');
  await expect(pop).toBeVisible();
  return (await pop.textContent()) || '';
}

test('Provision — Dry-run toggle shows a hover description', async ({ page }) => {
  await gotoTab(page, 'provision');
  await expect(page.locator('.page-title', { hasText: 'Provision' })).toBeVisible();
  const dry = page.locator('label.check-row', { hasText: 'Dry-run' }).first();
  const txt = await hoverText(page, dry);
  expect(txt.toLowerCase()).toContain('preview');
  expect(txt.toLowerCase()).toContain('no changes');
});

test('Provision — Space field shows a hover description', async ({ page }) => {
  await gotoTab(page, 'provision');
  const spaceLbl = page.locator('label.field-lbl', { hasText: 'Space' }).first();
  const txt = await hoverText(page, spaceLbl);
  expect(txt.toLowerCase()).toContain('address');
});

test('Provision — Live log panel shows an SSE hover description', async ({ page }) => {
  await gotoTab(page, 'provision');
  const log = page.locator('.pcard h3 span', { hasText: 'Live log' }).last();
  const txt = await hoverText(page, log);
  expect(txt.toLowerCase()).toContain('step');
});

test('Drift — Check drift button shows a hover description', async ({ page }) => {
  await gotoTab(page, 'drift');
  await expect(page.locator('.page-title', { hasText: 'Drift' })).toBeVisible();
  // Select a template so the Check drift button is enabled (disabled buttons emit no hover events).
  await page.locator('label.field-lbl', { hasText: 'Template' }).first().locator('select').selectOption('demo-site');
  const btn = page.locator('button', { hasText: 'Check drift' }).first();
  const txt = await hoverText(page, btn);
  expect(txt.toLowerCase()).toContain('template');
  expect(txt.toLowerCase()).toContain('infoblox');
});

test('Self-Service — Dry-run toggle shows a hover description', async ({ page }) => {
  await gotoTab(page, 'selfservice');
  await expect(page.locator('.page-title', { hasText: 'Self-Service' })).toBeVisible();
  const dry = page.locator('label.check-row', { hasText: 'Dry-run' }).first();
  const txt = await hoverText(page, dry);
  expect(txt.toLowerCase()).toContain('no changes');
});

test('Self-Service — Tag key field shows a next-available hover description', async ({ page }) => {
  await gotoTab(page, 'selfservice');
  const tag = page.locator('label.field-lbl', { hasText: 'Tag key' }).first();
  const txt = await hoverText(page, tag);
  expect(txt.toLowerCase()).toContain('tag');
});
