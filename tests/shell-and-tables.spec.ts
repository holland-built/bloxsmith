import { test, expect } from './fixtures';
import { installFixtures } from './page-fixtures';

// GUI audit round 1, job w2 (2026-11-25): the phone table scroll cue (A1, C3,
// B5), the phone bar showing where you are (A12, D13, E3), the side menu not
// jumping when the current item is bold (E4), and a one-tile strip (B7).

// A1, C3, B5. On a phone a wide table swipes sideways, but nothing said so, so
// the columns on the right (and buttons like Block and Resolve) looked missing.
// The right edge now fades while more of the table is off to the right, and the
// fade goes once the table is scrolled to its end. Every column stays.
test('on a phone a wide table fades at the right edge until it is scrolled to the end', async ({ page }) => {
  await installFixtures(page, 'network');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#network');
  const scroller = page.locator('[data-panel-id="network-exhaustion"] table').first().locator('xpath=..');
  await expect(scroller).toBeVisible();
  const wide = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(wide, 'the subnet table should be wider than a phone screen').toBe(true);

  const fade = () => scroller.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--scroll-cue-end')) || 0);
  await expect.poll(fade, { message: 'the right edge should fade while more is off to the right' }).toBeGreaterThan(8);

  await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect.poll(fade, { message: 'the fade should go once the table is scrolled to its end' }).toBe(0);
});

test('on a wide screen a table that fits has no fade', async ({ page }) => {
  await installFixtures(page, 'network');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#network');
  const scroller = page.locator('[data-panel-id="network-exhaustion"] table').first().locator('xpath=..');
  await expect(scroller).toBeVisible();
  await page.waitForTimeout(300);
  const fade = await scroller.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--scroll-cue-end')) || 0);
  expect(fade).toBe(0);
});

// A12, D13, E3. The phone bar lists five jobs. On any other page it marked
// nothing, so it gave no sign of where you were. It now shows the page's name,
// and that item alone is marked as the current page.
for (const [id, name] of [['value', 'Value'], ['provision', 'Provision'], ['lists', 'Site lists'], ['made', 'Made with Bloxsmith']] as const) {
  test(`on a phone the bottom bar names the current page on ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#${id}`);
    const bar = page.locator('[data-job-bar]');
    await expect(bar).toBeVisible();
    const current = bar.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAccessibleName(name);
    await expect(current).toBeVisible();
    // The name is shown in words, not only read out.
    const shown = await current.evaluate((el) => {
      const r = [...el.querySelectorAll('span')].find((s) => s.textContent === el.textContent)?.getBoundingClientRect();
      return !!r && r.width > 20 && r.height > 8;
    });
    expect(shown).toBe(true);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
}

test('on a phone a job page is marked in the bar with no extra item', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#daily');
  const bar = page.locator('[data-job-bar]');
  await expect(bar.getByRole('link')).toHaveText(['Overview', 'Get an address', 'Automate', 'Daily report', 'Build a chart']);
  await expect(bar.locator('[aria-current="page"]')).toHaveAccessibleName('Daily report');
  await expect(bar.locator('[aria-current]')).toHaveCount(1);
});

// E4. On Build a chart the bold current item wrapped to two lines, and every
// item below it dropped 8px, so the menu jumped when you changed pages.
test('the side menu items stay in place when the current item turns bold', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const tops = async (hash: string) => {
    await page.goto(`/${hash}`);
    const rail = page.locator('[data-job-rail]');
    // On #ai the Ask group is marked; on #chart the Build a chart link is.
    await expect(rail.locator('[aria-current]')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    return rail.locator(':scope > .frame-link, :scope > [data-nav-group] > button').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  };
  const onAi = await tops('#ai');
  const onChart = await tops('#chart');
  expect(onChart).toEqual(onAi);
  // Bold is still the non-colour sign of the current item.
  const weight = await page.locator('[data-job-rail] [aria-current="page"]').evaluate((e) => getComputedStyle(e).fontWeight);
  expect(Number(weight)).toBeGreaterThanOrEqual(600);
});

// B7. A strip with one tile fell back to the six-column default, so the tile
// filled a sixth of the row and the rest was an empty grey slab.
for (const width of [390, 1440]) {
  test(`a strip with one tile fills its row at ${width}`, async ({ page }) => {
    await installFixtures(page, 'assets');
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#assets');
    const strip = page.locator('[data-panel-id="assets-coverage"] ul[aria-label="Coverage gaps"]');
    await expect(strip.locator(':scope > li')).toHaveCount(1);
    const [s, t] = await Promise.all([strip.boundingBox(), strip.locator(':scope > li').boundingBox()]);
    expect(t!.width).toBeGreaterThan(s!.width - 4);
  });
}
