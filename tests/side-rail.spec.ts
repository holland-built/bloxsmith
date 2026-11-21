import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The rail opens over the page when the pointer moves onto it, and closes when
// the pointer leaves. arrange-names.spec.ts covers a pointer left resting where
// the rail is, which on Linux held the rail open over the page.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('moving onto the rail opens it, and moving off closes it', async ({ page }) => {
  await page.goto('/#overview');
  const rail = page.locator('.frame-rail');
  await expect(rail).toBeVisible();
  await page.mouse.move(600, 400);
  await page.mouse.move(20, 200, { steps: 3 });
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(232);
  await page.mouse.move(600, 400, { steps: 3 });
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(56);
});
