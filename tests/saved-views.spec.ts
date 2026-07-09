import { test, expect } from '@playwright/test';

// Real app + live server. Full round-trip through the ViewsMenu topbar dropdown:
// save (POST) -> reload -> apply (GET) -> delete (DELETE, two-step confirm).

const VIEW_NAME = 'e2e-test-view';

test('save, apply, and delete a saved view via the UI', async ({ page }) => {
  // Pre-clean any leftover from a previous failed run so re-runs pass.
  await page.request.delete('/api/views/' + encodeURIComponent(VIEW_NAME)).catch(() => {});

  // window.prompt('Save current view as:') supplies the name.
  page.on('dialog', d => d.accept(VIEW_NAME));

  await page.goto('/#network');
  await expect(page.locator('.tabbar')).toBeVisible();

  const viewsBtn = page.getByRole('button', { name: 'Views', exact: true });
  await expect(viewsBtn).toBeVisible();

  // Save current view.
  await viewsBtn.click();
  await page.locator('.views-item', { hasText: 'Save current…' }).click();
  // Toast confirms the POST landed.
  await expect(page.locator('.toast', { hasText: VIEW_NAME })).toBeVisible();

  // Reload -> view persisted server-side, appears in the menu.
  await page.reload();
  await page.getByRole('button', { name: 'Views', exact: true }).click();
  const savedRow = page.locator('.views-row', { hasText: VIEW_NAME });
  await expect(savedRow).toBeVisible();

  // Apply it (GET /api/views/<name>).
  await savedRow.locator('.views-item').click();
  await expect(page.locator('.toast', { hasText: 'applied' })).toBeVisible();

  // Delete it: two-step confirm (✕ -> delete).
  await page.getByRole('button', { name: 'Views', exact: true }).click();
  const row = page.locator('.views-row', { hasText: VIEW_NAME });
  await row.getByRole('button', { name: 'Delete view ' + VIEW_NAME }).click();
  await row.locator('.views-mini.crit', { hasText: 'delete' }).click();
  await expect(page.locator('.toast', { hasText: 'Deleted' })).toBeVisible();

  // Verify the DELETE round-trip server-side.
  const after = await page.request.get('/api/views');
  const body = await after.json();
  const names = (body.views || []).map((v: any) => v.name);
  expect(names).not.toContain(VIEW_NAME);
});
