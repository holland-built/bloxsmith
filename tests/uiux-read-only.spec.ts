import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// UI/UX review 2026-10-30: on a read-only tenant, Security showed a live
// "Block" on every row and Incidents a live "Resolve"/"Reopen", though the
// server refuses both (go/internal/server/writelock.go). Only Provision said
// the tenant was read-only.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (route) => route.fulfill({
    json: { known: true, tenant: 'lab/-', label: 'Lab', writable: false },
  }));
});

test('Security: Block is off on a read-only tenant, and the panel says why', async ({ page }) => {
  await page.goto('/#security');
  const panel = page.locator('[data-panel-id="security-triage-inbox"]');
  const block = panel.getByRole('button', { name: 'Block' }).first();
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(block).toBeDisabled();
  await expect(panel).toContainText('Lab is read-only');
});

test('Incidents: Resolve and Reopen are off on a read-only tenant, and the panel says why', async ({ page }) => {
  await page.goto('/#incidents');
  const panel = page.locator('[data-panel-id="incidents-soc-queue"]');
  const btn = panel.getByRole('button', { name: /^(Resolve|Reopen)$/ }).first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await expect(btn).toBeDisabled();
  await expect(panel).toContainText('Lab is read-only');
});

for (const [tab, name] of [['selfservice', 'Self-Service'], ['editor', 'Editor']] as const) {
  test(`${name}: says the tenant is read-only and that Preview still works`, async ({ page }) => {
    await page.goto(`/#${tab}`);
    const note = page.locator('[data-read-only-note]');
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(note).toContainText('Lab is read-only');
    await expect(note).toContainText('Preview works');
  });
}

test('a writable tenant shows no read-only note and Block is on', async ({ page }) => {
  await page.unroute('**/api/vault/write-target*');
  await page.route('**/api/vault/write-target*', (route) => route.fulfill({
    json: { known: true, tenant: 'lab/-', label: 'Lab', writable: true },
  }));
  await page.goto('/#security');
  const block = page.locator('[data-panel-id="security-triage-inbox"]').getByRole('button', { name: 'Block' }).first();
  await expect(block).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('[data-read-only-note]')).toHaveCount(0);
});
