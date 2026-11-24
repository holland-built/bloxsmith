import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The side bar never moves by itself (owner, 2026-11-23: "this constantly
// popping is terrible"). The narrow bar shows each icon with its word. A group
// icon opens one small panel on click. One caret opens the full menu, which
// pushes the page over and stays open across a refresh.

const WORDS = ['Overview', 'Get an address', 'Automate', 'Daily report', 'Charts', 'Status', 'Inventory', 'Risk', 'Change', 'Ask'];
const GROUPS = ['Status', 'Inventory', 'Risk', 'Change', 'Ask'];

const rail = (page: Page) => page.locator('.frame-rail');
const nav = (page: Page) => page.locator('nav[data-job-rail]');
const group = (page: Page, name: string) => nav(page).getByRole('button', { name: `${name} pages` });
const caret = (page: Page) => rail(page).getByRole('button', { name: 'Full menu' });
const panels = (page: Page) => page.locator('.frame-panel');
const railWidth = async (page: Page) => (await rail(page).boundingBox())!.width;
const pageLeft = async (page: Page) => (await page.locator('.frame-col').boundingBox())!.x;

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('1: hovering or focusing never opens, widens or moves the bar', async ({ page }) => {
  await page.goto('/#overview');
  await expect(rail(page)).toBeVisible();
  const width = await railWidth(page);
  const left = await pageLeft(page);
  await page.mouse.move(600, 400);
  await page.mouse.move(20, 200, { steps: 3 });
  await page.waitForTimeout(250);
  expect(await railWidth(page)).toBe(width);
  expect(await pageLeft(page)).toBe(left);
  await expect(panels(page)).toHaveCount(0);
  await page.mouse.move(600, 400);
  await nav(page).getByRole('link', { name: 'Automate' }).focus();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(250);
  expect(await railWidth(page)).toBe(width);
  await expect(panels(page)).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`2: ${theme}: the narrow bar shows every word, readable and unclipped`, async ({ page }) => {
    await page.addInitScript(`localStorage.setItem('theme', ${JSON.stringify(theme)})`);
    await page.goto('/#overview');
    const width = await railWidth(page);
    expect(width).toBeGreaterThanOrEqual(76);
    expect(width).toBeLessThanOrEqual(88);
    const words = nav(page).locator('.frame-link-text');
    await expect(words).toHaveCount(WORDS.length);
    for (let i = 0; i < WORDS.length; i++) {
      const word = words.nth(i);
      await expect(word).toBeVisible();
      expect((await word.innerText()).replace(/\s+pages$/, '').replace(/\s+/g, ' ').trim()).toBe(WORDS[i]);
      const m = await word.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const link = el.closest('.frame-link')!.getBoundingClientRect();
        return { size: parseFloat(getComputedStyle(el).fontSize), w: r.width, h: r.height, sw: el.scrollWidth, sh: el.scrollHeight, inside: r.left >= link.left && r.right <= link.right };
      });
      expect(m.size).toBeGreaterThanOrEqual(11);
      expect(m.w).toBeGreaterThan(20);
      expect(m.sw).toBeLessThanOrEqual(Math.ceil(m.w));
      expect(m.sh).toBeLessThanOrEqual(Math.ceil(m.h));
      expect(m.inside).toBe(true);
    }
  });
}

test('3: clicking an icon with one page goes to that page', async ({ page }) => {
  await page.goto('/#overview');
  await nav(page).getByRole('link', { name: 'Daily report' }).click();
  await expect(page).toHaveURL(/#daily$/);
  await expect(panels(page)).toHaveCount(0);
});

test('4: a group icon opens one panel, and a page, the icon, outside or Escape closes it', async ({ page }) => {
  await page.goto('/#overview');
  const risk = group(page, 'Risk');
  await expect(risk).toHaveAttribute('aria-expanded', 'false');
  await risk.click();
  await expect(risk).toHaveAttribute('aria-expanded', 'true');
  await expect(panels(page)).toHaveCount(1);
  await expect(panels(page).getByRole('link', { name: 'Audit' })).toBeVisible();
  const box = (await panels(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(await railWidth(page));

  // Only one at a time.
  await group(page, 'Inventory').click();
  await expect(panels(page)).toHaveCount(1);
  await expect(panels(page).getByRole('link', { name: 'DNS' })).toBeVisible();
  await expect(risk).toHaveAttribute('aria-expanded', 'false');

  // The same icon closes it.
  await group(page, 'Inventory').click();
  await expect(panels(page)).toHaveCount(0);

  // Clicking outside closes it.
  await risk.click();
  await page.mouse.click(900, 500);
  await expect(panels(page)).toHaveCount(0);

  // Escape closes it and returns to the icon, from inside the panel too.
  await risk.click();
  await panels(page).getByRole('link', { name: 'Audit' }).focus();
  await page.keyboard.press('Escape');
  await expect(panels(page)).toHaveCount(0);
  await expect(risk).toBeFocused();

  // Picking a page goes there and closes it.
  await risk.click();
  await panels(page).getByRole('link', { name: 'Audit' }).click();
  await expect(page).toHaveURL(/#audit$/);
  await expect(panels(page)).toHaveCount(0);

  // Picking the page you are already on closes it too.
  await risk.click();
  await panels(page).getByRole('link', { name: 'Audit' }).click();
  await expect(panels(page)).toHaveCount(0);
  await expect(risk).toBeFocused();
});

test('5: the caret opens the full menu, moves the page over, and survives a refresh', async ({ page }) => {
  await page.goto('/#overview');
  const narrow = await railWidth(page);
  const left = await pageLeft(page);
  await expect(caret(page)).toBeVisible();
  await expect(caret(page)).toHaveAttribute('aria-expanded', 'false');
  await caret(page).click();
  await expect(caret(page)).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => railWidth(page)).toBeGreaterThan(200);
  const wide = await railWidth(page);
  // The page starts where the menu ends, so nothing is covered.
  expect(await pageLeft(page)).toBe(left + (wide - narrow));
  await page.mouse.move(900, 500);
  await page.waitForTimeout(250);
  expect(await railWidth(page)).toBe(wide);

  await page.reload();
  await expect(caret(page)).toHaveAttribute('aria-expanded', 'true');
  expect(await railWidth(page)).toBe(wide);

  await caret(page).click();
  await expect.poll(() => railWidth(page)).toBe(narrow);
  expect(await pageLeft(page)).toBe(left);
  await page.reload();
  await expect(caret(page)).toHaveAttribute('aria-expanded', 'false');
});

test('5: the menu still works when this browser blocks saved settings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const blocked = () => { throw new Error('storage blocked'); };
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k: string) { return k.startsWith('bloxsmith.nav') ? blocked() : get.call(this, k); };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) { return k.startsWith('bloxsmith.nav') ? blocked() : set.call(this, k, v); };
  });
  await page.goto('/#overview');
  await caret(page).click();
  await expect(caret(page)).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

// The mark is a solid outline plus bold text, so it does not depend on telling
// two colours apart.
const expectMarked = async (page: Page, selector: string) => {
  const m = await page.locator(selector).evaluate((el) => {
    const s = getComputedStyle(el);
    return { shadow: s.boxShadow, weight: Number(s.fontWeight) };
  });
  expect(m.shadow).toContain('inset');
  // A faint 1px ring since the owner's pick of 2026-11-24; bold text is the
  // second sign, so colour is never the only one.
  expect(m.shadow).toContain('1px');
  expect(m.weight).toBeGreaterThanOrEqual(600);
};

test('6: the current page is marked in the bar, the panel and the full menu', async ({ page }) => {
  await page.goto('/#overview');
  await expectMarked(page, 'nav[data-job-rail] a[aria-current="page"]');
  await page.goto('/#audit');
  await expect(group(page, 'Risk')).toHaveAttribute('aria-current', 'true');
  await expectMarked(page, '[data-nav-group="risk"] > button');
  await group(page, 'Risk').click();
  await expect(panels(page).getByRole('link', { name: 'Audit' })).toHaveAttribute('aria-current', 'page');
  await expectMarked(page, '.frame-panel a[aria-current="page"]');
  await page.keyboard.press('Escape');
  await caret(page).click();
  await expectMarked(page, 'nav[data-job-rail] a[aria-current="page"]');
});

test('keyboard: every control is reachable, named and ringed, and groups report their state', async ({ page }) => {
  await page.goto('/#overview');
  await page.locator('.frame-skip').focus();
  const seen: string[] = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      if (!el.closest('.frame-rail')) return null;
      const s = getComputedStyle(el);
      return { name: el.getAttribute('aria-label') || el.textContent?.replace(/\s+/g, ' ').trim() || '', ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 };
    });
    if (!f) break;
    expect(f.name).not.toBe('');
    expect(f.ring, `${f.name} shows a focus ring`).toBe(true);
    seen.push(f.name);
  }
  expect(seen).toContain('Full menu');
  for (const w of WORDS.slice(0, 5)) expect(seen).toContain(w);
  for (const g of GROUPS) expect(seen).toContain(`${g} pages`);

  await group(page, 'Change').focus();
  await page.keyboard.press('Enter');
  await expect(group(page, 'Change')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(panels(page).getByRole('link').first()).toBeFocused();
});

test('reduced motion: the bar and the page do not animate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#overview');
  const d = await rail(page).evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(d.split(',').every((x) => parseFloat(x) === 0)).toBe(true);
});

for (const width of [961, 1200, 1440, 2000]) {
  test(`no sideways page scroll at ${width}px, with the bar, a panel and the full menu`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#overview');
    await expect(caret(page)).toBeVisible();
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await fits()).toBe(true);
    await group(page, 'Change').click();
    expect(await fits()).toBe(true);
    await page.keyboard.press('Escape');
    await caret(page).click();
    await page.waitForTimeout(200);
    expect(await fits()).toBe(true);
  });
}
