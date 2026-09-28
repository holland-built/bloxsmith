import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Ask tab, threat lookup: while a lookup is running the Lookup button is
// disabled, and Enter in the search box must be too. Enter used to start a
// second lookup regardless, sending the same pair of requests again.

test('Enter does not start a second lookup while one is running', async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  let lookups = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/threat-lookup*', async (route) => {
    lookups += 1;
    await held;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entities: [], availability: 'ok' }) });
  });
  await page.goto('/#ai');
  const box = page.getByPlaceholder('domain, IP, or host…');
  await box.fill('slow.example.com');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Looking up…' })).toBeDisabled();
  await expect.poll(() => lookups).toBe(1);

  await box.press('Enter');
  await box.press('Enter');
  // Give a second request time to reach the route before taking one reading.
  await page.waitForTimeout(500);
  const whileBusy = lookups;
  release();
  await expect(page.getByRole('button', { name: 'Lookup', exact: true })).toBeEnabled();
  expect(whileBusy).toBe(1);

  // Once it has finished, Enter works again.
  await box.press('Enter');
  await expect.poll(() => lookups).toBe(2);
});
