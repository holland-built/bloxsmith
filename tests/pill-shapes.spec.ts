import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { installBaselineWorld, installFixtures } from './page-fixtures';

// Every page in the app, from the one list the menus use.
const APP = readFileSync(path.join(__dirname, '../ui/src/App.jsx'), 'utf8');
const TABS_SRC = APP.slice(APP.indexOf('const TABS = ['), APP.indexOf('\n]', APP.indexOf('const TABS = [')));
const PAGES = [...TABS_SRC.matchAll(/\{ id: '([^']+)'/g)].map((m) => m[1]);

// The look picked on 2026-11-24 makes a row of pick buttons into pills. A pill
// is for a one-line button: on anything taller (a two-line choice, the list
// that holds them) the same rounding draws an oval. Automate's job list came
// out as a large circle with curved lines between the jobs.
for (const width of [1440, 390]) {
  for (const id of PAGES) {
    test(`#${id} at ${width}: nothing taller than a button is drawn as a pill`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await installBaselineWorld(page);
      await page.goto(`/#${id}`);
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState('networkidle');
      const ovals = await page.evaluate(() => {
        const bad: string[] = [];
        for (const el of Array.from(document.querySelectorAll('main *')) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.height <= 46 || r.width === 0) continue; // a 44px touch button may be a full pill
          const rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
          // 40%, not 50%: a 22px corner on a 50px two-line button leaves only
          // 6px of straight side, which reads as an oval (Automate's IP space
          // suggestion, 2026-11-25). A full half-height check let it through.
          if (rad >= r.height * 0.4) bad.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || '').trim().slice(0, 30)}"`);
        }
        return bad;
      });
      expect(ovals).toEqual([]);
    });
  }
}

test('Automate: the jobs are a plain list, with straight lines between them', async ({ page }) => {
  await installFixtures(page, 'automate');
  await page.goto('/#automate');
  const jobs = page.getByRole('navigation', { name: 'Jobs to automate' }).getByRole('button');
  await expect(jobs.first()).toBeVisible({ timeout: 20_000 });
  for (const r of await jobs.evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopLeftRadius))) expect(r).toBe('0px');
});
