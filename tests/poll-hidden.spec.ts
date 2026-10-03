import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// A TAB NOBODY IS LOOKING AT DOES NOT POLL.
//
// useApi's interval used to fire whether or not the page was visible: an idle
// background tab kept sending about 25 requests a minute (Security alone has 11
// hooks polled every 30 s), each one re-rendering panels nobody could see. The
// interval now skips while document.hidden, and a return to the tab fetches at
// once.
//
// document.hidden is overridden because headless Chromium has no way to hide the
// page, and the clock is faked so two minutes of polling do not cost two minutes.

async function setHidden(page: import('@playwright/test').Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('a hidden tab stops polling, and coming back fetches at once', async ({ page }) => {
  await installBaselineWorld(page);
  await page.clock.install();

  let count = 0;
  await page.route('**/api/data', async (route) => {
    count += 1;
    await route.fallback();
  });

  await page.goto('/#overview');
  await expect(page.locator('[data-panel-id="top-consumers"]')).toBeVisible({ timeout: 20_000 });

  // Proof the interval is live while visible: two minutes of fake time is four
  // 30-second polls (and two 60-second ones). Without this the hidden half below
  // could pass on a page that never polled at all.
  const beforeVisible = count;
  await page.clock.runFor(125_000);
  await expect.poll(() => count, { message: 'a visible tab must keep polling' }).toBeGreaterThan(beforeVisible);

  await setHidden(page, true);
  // Let anything already in flight settle, then count from here.
  await page.waitForTimeout(500);
  const whileHidden = count;
  await page.clock.runFor(125_000);
  await page.waitForTimeout(500);
  expect(count, `a hidden tab made ${count - whileHidden} /api/data request(s)`).toBe(whileHidden);

  await setHidden(page, false);
  await expect.poll(() => count, { message: 'returning to the tab must refresh at once' }).toBeGreaterThan(whileHidden);
});
