import { test, expect } from '@playwright/test';

// v2 "answer-first" layout: every tab leads with a synthesis band (.band, from the
// SynthBand component) rendered ABOVE its data table. Runs against the real app
// (vault unlocked live), waiting for data so the band's verdict/facts populate.

const TABS = ['overview', 'daily', 'network', 'dns', 'infra', 'security', 'audit', 'ask'];

// DailyTab now leads with a real SynthBand (.band) like every other tab.
const NO_BAND = new Set<string>([]);

for (const tab of TABS) {
  const runner = NO_BAND.has(tab) ? test.fixme : test;
  runner(`#${tab} leads with a synthesis .band above its table`, async ({ page }) => {
    await page.goto('/#' + tab, { waitUntil: 'networkidle' });
    await expect(page.locator('.tabbar')).toBeVisible();
    await page.waitForTimeout(1200);

    const band = page.locator('.main .band').first();
    await expect(band, `no .band synthesis element on #${tab}`).toBeVisible({ timeout: 15000 });

    // If this tab renders a data table, the band must come first in DOM order.
    const tableCount = await page.locator('.main table').count();
    if (tableCount > 0) {
      const ordered = await page.evaluate(() => {
        const b = document.querySelector('.main .band');
        const t = document.querySelector('.main table');
        if (!b || !t) return null;
        // Node.DOCUMENT_POSITION_FOLLOWING (4): t follows b => band precedes table.
        return !!(b.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(ordered, `.band must precede the first table on #${tab}`).toBe(true);
    }
  });
}
