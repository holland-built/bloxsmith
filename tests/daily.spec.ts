import { test, expect } from '@playwright/test';

// v2 Daily-summary exec view (#daily / DailyTab). A fresh Playwright context has
// empty localStorage, so the snapshot store (bx.snaps) is empty -> priorDays == []
// -> firstRun is true -> the first-visit note shows and delta cells are hidden.
// We assert structure + the fallback narrative, never the LLM sentence text.

test('daily renders delta tiles, open-issues rollup, and first-visit note', async ({ page }) => {
  await page.goto('/#daily', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // Narrative sentence element is present (fallback copy is fine; LLM path optional).
  // v2: the narrative lead is now the shared SynthBand verdict at the top of the tab.
  const lead = page.locator('.band .band-verdict');
  await expect(lead).toBeVisible({ timeout: 15000 });
  await expect(lead).not.toHaveText('');

  // Delta-tiles region with at least one tile.
  await expect(page.locator('.dly-tiles')).toBeVisible();
  await expect(page.locator('.dly-tile').first()).toBeVisible();

  // "Open issues" rollup section exists.
  await expect(page.locator('.main').getByText('Open issues', { exact: true })).toBeVisible();

  // First visit (no prior snapshot) -> the first-visit note is shown.
  await expect(page.locator('.dly-note')).toContainText('First visit');
});
