import { test, expect } from '@playwright/test';

// One h1 per tab (verified against ui/src/tabs/*.jsx). Hopping tab-to-tab
// after each visit exercises unmount/setState-after-unmount console warnings,
// not just the initial mount.
const TABS = [
  'overview', 'daily', 'network', 'dns', 'security', 'infra', 'incidents',
  'audit', 'provision', 'selfservice', 'editor', 'drift', 'ai',
];

function isNoise(text: string) {
  return /favicon|net::ERR_/i.test(text);
}

for (let i = 0; i < TABS.length; i++) {
  const id = TABS[i];
  const next = TABS[(i + 1) % TABS.length];

  test(`tab "${id}" renders with no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isNoise(msg.text())) errors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      if (!isNoise(err.message)) errors.push(err.message);
    });

    await page.goto(`/#${id}`);
    await expect(page.locator('h1').first()).toBeVisible();

    // Hop to the next tab via hashchange (client-side route, no reload) to
    // catch unmount-time setState-after-unmount warnings.
    await page.evaluate((h) => { location.hash = h; }, next);
    await expect(page.locator('h1').first()).toBeVisible();

    expect(errors, `console errors while visiting #${id} -> #${next}`).toEqual([]);
  });
}
