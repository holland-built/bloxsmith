import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Fix 3 (2026-11-24): a panel's About and menu buttons dropped onto a line of
// their own under the title whenever the title, its caption or the text on the
// right did not fit beside them: on every phone, and on Assets at desktop width.
// They belong on the title line; the caption is what wraps underneath.

// Every titled panel: is its menu button on the same line as its title?
async function buttonsOffTitleLine(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const off: string[] = [];
    for (const card of Array.from(document.querySelectorAll('[data-panel-id]'))) {
      const title = card.querySelector('h2');
      // The menu toggle is the last of the two buttons; it is drawn in every
      // titled panel that can be arranged.
      const menu = card.querySelector('[data-panel-menu-toggle]');
      if (!title || !menu || title.closest('[data-panel-id]') !== card) continue;
      const t = title.getBoundingClientRect();
      const b = menu.getBoundingClientRect();
      if (!b.width) continue;
      if (b.top >= t.bottom - 1) off.push(card.getAttribute('data-panel-id') || '?');
    }
    return off;
  });
}

for (const [hash, w, h] of [
  ['network', 320, 700],
  ['network', 390, 844],
  ['dns', 320, 700],
  ['dns', 390, 844],
  ['security', 320, 700],
  ['security', 390, 844],
  ['assets', 390, 844],
  ['assets', 1440, 900],
] as const) {
  test(`#${hash} at ${w}px: each panel's About and menu buttons sit on its title line`, async ({ page }) => {
    await installBaselineWorld(page);
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/#${hash}`);
    await expect(page.locator('[data-panel-id] h2').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await buttonsOffTitleLine(page)).toEqual([]);
  });
}

// On desktop the buttons stay centred on the title line, as before fix 3: a
// search box on the right makes the row taller, and buttons pinned to its top
// edge sat about 5px above the title.
for (const hash of ['assets', 'network', 'infra'] as const) {
  test(`#${hash} at 1440px: About and menu buttons are centred on the title line`, async ({ page }) => {
    await installBaselineWorld(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/#${hash}`);
    await expect(page.locator('[data-panel-id] h2').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    const off = await page.evaluate(() => {
      const bad: string[] = [];
      for (const card of Array.from(document.querySelectorAll('[data-panel-id]'))) {
        const title = card.querySelector('h2');
        const menu = card.querySelector('[data-panel-menu-toggle]');
        if (!title || !menu || title.closest('[data-panel-id]') !== card) continue;
        const t = title.getBoundingClientRect();
        const b = menu.getBoundingClientRect();
        if (!b.width) continue;
        if (Math.abs((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2) > 2) bad.push(card.getAttribute('data-panel-id') || '?');
      }
      return bad;
    });
    expect(off).toEqual([]);
  });
}

// On a touch phone the buttons are 44px, taller than a one-line title, and the
// row under the title may use the width beside them. It must start below them.
test('#assets on a touch phone: the search row never sits under the buttons', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await installBaselineWorld(page);
  await page.goto('/#assets');
  const box = page.getByLabel('Search assets by name, IP or MAC address', { exact: true });
  await expect(box).toBeVisible({ timeout: 20_000 });
  const overlap = await box.evaluate((el) => {
    const card = el.closest('[data-panel-id]')!;
    const menu = card.querySelector('[data-panel-menu-toggle]')!.parentElement!.getBoundingClientRect();
    const row = el.parentElement!.getBoundingClientRect();
    return row.top < menu.bottom && row.right > menu.left;
  });
  expect(overlap).toBe(false);
  await ctx.close();
});

// A caption long enough to wrap must not take width from the row under it.
test('#assets at 390: a wrapped caption leaves the search row its full width', async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#assets');
  const box = page.getByLabel('Search assets by name, IP or MAC address', { exact: true });
  await expect(box).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  const { row, head } = await box.evaluate((el) => {
    const h = el.closest('[data-panel-id]')!.querySelector('h2')!.parentElement!;
    const cs = getComputedStyle(h);
    return { row: el.parentElement!.parentElement!.getBoundingClientRect().width, head: h.getBoundingClientRect().width - parseFloat(cs.paddingLeft) };
  });
  expect(Math.round(row)).toBeGreaterThanOrEqual(Math.round(head) - 1);
});
