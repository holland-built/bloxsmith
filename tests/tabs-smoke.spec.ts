import { test, expect } from './fixtures';

// One h1 per tab (verified against ui/src/tabs/*.jsx). Hopping tab-to-tab
// after each visit exercises unmount/setState-after-unmount console warnings,
// not just the initial mount.
//
// ALL FIFTEEN, AND THE COUNT IS THE POINT. 'assets' was missing from this list
// until 2026-08-08 — a real tab with a real h1 that nothing here ever opened.
// That matters more than it used to: every tab now carries a layoutKey, and
// CardGrid's wrapped-panel guard reports a mis-wired grid by calling
// console.error (components/ui.jsx — deliberately not a throw, so a broken
// saved order cannot take a tab down). A console.error with no test watching
// for it is a silent failure, so this file is the main thing standing between
// that rollout and a tab that quietly cannot restore its own layout. A tab
// absent from this array is a tab with no guard at all.
//
// The 15 ids are the tab ids themselves, which are also the layout keys —
// except Provision, which renders a different grid per mode and uses three
// (provision-subnet / provision-site / provision-seed).
const TABS = [
  'overview', 'daily', 'network', 'dns', 'security', 'infra', 'assets', 'incidents',
  'audit', 'changes', 'provision', 'selfservice', 'editor', 'drift', 'ai',
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
