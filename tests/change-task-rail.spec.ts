import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Change tabs ("C · Task rail", picked over a dense worksheet and a single
// reading column) carry a list of the panels on the page beside the forms. It
// reads the panels off the page, so it must always name exactly the panels
// shown, follow Provision's mode switch, and jump to the panel it names.

const rail = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'On this page' });
const railItems = (page: import('@playwright/test').Page) => rail(page).getByRole('button').allTextContents();
const panelTitles = (page: import('@playwright/test').Page) =>
  page.$$eval('[data-card-grid] [data-panel-id]', (els) =>
    els.map((el) => el.querySelector('h2')?.textContent?.trim() || el.getAttribute('data-panel-id') || ''),
  );

// Also after every test, so a failed assertion cannot leave the view behind.
test.afterEach(async ({ request }) => {
  await request.delete('/api/views/__layout_selfservice');
});

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

for (const tab of ['provision', 'selfservice', 'editor', 'drift']) {
  test(`#${tab}: the rail names exactly the panels on the page, in order`, async ({ page }) => {
    await page.goto(`/#${tab}`);
    await expect(rail(page)).toBeVisible();
    await expect.poll(async () => (await railItems(page)).length).toBeGreaterThan(0);
    await expect.poll(() => railItems(page)).toEqual(await panelTitles(page));
  });
}

test('the rail follows Provision\'s mode switch', async ({ page }) => {
  await page.goto('/#provision');
  await expect.poll(() => railItems(page)).toEqual(['Request', 'Live log']);
  await page.getByRole('button', { name: 'Full site', exact: true }).click();
  await expect.poll(() => railItems(page)).not.toEqual(['Request', 'Live log']);
  await expect.poll(() => railItems(page)).toEqual(await panelTitles(page));
});

test('a rail item moves focus to its panel, clear of the sticky header', async ({ page }) => {
  // Short viewport, and a panel with page below it, so the jump really does
  // scroll it to the top edge where the header sits.
  // Reduced motion makes the jump instant, so the measurement below is taken
  // after the scroll and not before a smooth scroll has started.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 400 });
  await page.goto('/#provision');
  await rail(page).getByRole('button', { name: 'Request' }).click();
  const panel = page.locator('[data-panel-id="provision-subnet-request"]');
  await expect(panel).toBeFocused();
  const headerBottom = await page.locator('header').first().evaluate((h) => h.getBoundingClientRect().bottom);
  expect(await page.evaluate(() => window.scrollY), 'the jump did not scroll').toBeGreaterThan(0);
  expect(await panel.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(headerBottom);
});

test('the rail follows a panel title change (Editor type switch)', async ({ page }) => {
  await page.goto('/#editor');
  await expect.poll(() => railItems(page)).toEqual(['DNS Zone — Create']);
  await page.getByRole('button', { name: 'Subnet', exact: true }).click();
  await expect.poll(() => railItems(page)).toEqual(await panelTitles(page));
  expect(await railItems(page)).not.toEqual(['DNS Zone — Create']);
});

test('a long live log does not make the rail re-read the page per line', async ({ page }) => {
  await page.goto('/#provision');
  await expect.poll(() => railItems(page)).toEqual(['Request', 'Live log']);
  // Count rail reads by counting the panel queries it makes, then append many
  // lines into the log panel the way a stream does.
  const reads = await page.evaluate(async () => {
    let n = 0;
    const orig = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (sel: string) {
      if (sel === '[data-card-grid] [data-panel-id]') n++;
      return orig.call(this, sel);
    } as typeof orig;
    const log = document.querySelector('[data-panel-id="provision-subnet-log"]')!;
    for (let i = 0; i < 200; i++) {
      const line = document.createElement('div');
      line.textContent = `line ${i}`;
      log.appendChild(line);
      await new Promise((r) => setTimeout(r, 0));
    }
    Element.prototype.querySelectorAll = orig;
    return n;
  });
  expect(reads).toBe(0);
});

test('a panel taken off the page leaves the rail', async ({ page, request }) => {
  // Hiding saves the Self-Service layout on the test server, and later specs
  // read that page, so the saved view is removed before and after.
  await request.delete('/api/views/__layout_selfservice');
  await page.goto('/#selfservice');
  await expect(rail(page).getByRole('button', { name: 'Manage Records' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide Manage Records' }).click();
  await expect(rail(page).getByRole('button', { name: 'Manage Records' })).toHaveCount(0);
});

test('on a phone there is no rail, and the forms keep the width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#selfservice');
  await expect(page.locator('[data-panel-id="selfservice-allocate"]')).toBeVisible();
  await expect(rail(page)).toBeHidden();
});
