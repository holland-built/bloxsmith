import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Provision's space and block lists carry a search box. A tenant can have
// hundreds of IP spaces (801 on the live one), and the plain dropdown was a long
// scroll. Typing narrows the list; the list stays a native select.

const SPACES = {
  spaces: [
    { id: 'ipam/ip_space/a', name: 'Amsterdam Lab' },
    { id: 'ipam/ip_space/b', name: 'Berlin Office' },
    { id: 'ipam/ip_space/c', name: 'jbriante-IP-Space' },
    { id: 'ipam/ip_space/d', name: 'Brussels Office' },
  ],
};

function json(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/ipam/spaces*', (route) => json(route, SPACES));
});

const options = (page: import('@playwright/test').Page, label: string) =>
  page.getByRole('combobox', { name: label, exact: true }).locator('option');

test('typing narrows the space list, ignoring case, and says how many match', async ({ page }) => {
  await page.goto('/#provision');
  await expect(options(page, 'Space')).toHaveCount(5); // placeholder + 4

  await page.getByRole('searchbox', { name: 'Search Space' }).fill('OFFICE');
  await expect(options(page, 'Space')).toHaveText(['Select a space (2 of 4 match)', 'Berlin Office', 'Brussels Office']);

  await page.getByRole('combobox', { name: 'Space', exact: true }).selectOption({ label: 'Brussels Office' });
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveValue('ipam/ip_space/d');
});

test('a chosen space stays chosen when the search no longer matches it', async ({ page }) => {
  await page.goto('/#provision');
  await page.getByRole('combobox', { name: 'Space', exact: true }).selectOption({ label: 'jbriante-IP-Space' });

  await page.getByRole('searchbox', { name: 'Search Space' }).fill('berlin');
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveValue('ipam/ip_space/c');
  await expect(options(page, 'Space')).toContainText(['jbriante-IP-Space', 'Berlin Office']);
});

test('a search with no match says so', async ({ page }) => {
  await page.goto('/#provision');
  await page.getByRole('searchbox', { name: 'Search Space' }).fill('tokyo');
  await expect(page.getByText('No space matches “tokyo”.')).toBeVisible();
  await expect(options(page, 'Space')).toHaveText(['Select a space (0 of 4 match)']);
});

test('the Full site and Seed demo space lists search the same way', async ({ page }) => {
  await page.goto('/#provision');
  for (const mode of ['Full site', 'Seed demo']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search IP space' }).first().fill('amster');
    await expect(page.getByRole('combobox', { name: 'IP space', exact: true }).first().locator('option')).toHaveText([
      '— template default — (1 of 4 match)', 'Amsterdam Lab',
    ]);
  }
});

// Typing shows the matches straight away, as buttons under the search box, so
// nobody has to open the dropdown to see them. The dropdown stays, holding
// every match, for anyone who prefers it.

const results = (page: import('@playwright/test').Page, label = 'space') =>
  page.getByRole('list', { name: `Matching ${label}` }).getByRole('button');

test('typing shows the matches as buttons, and a click picks one without opening the dropdown', async ({ page }) => {
  await page.goto('/#provision');
  const box = page.getByRole('searchbox', { name: 'Search Space' });
  await box.fill('office');
  await expect(results(page)).toHaveText(['Berlin Office', 'Brussels Office']);
  await expect(page.getByRole('status').filter({ hasText: '2 matches.' })).toBeVisible();

  await results(page).filter({ hasText: 'Brussels Office' }).click();
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveValue('ipam/ip_space/d');
  // The search clears, the list goes, and focus returns to the box.
  await expect(box).toHaveValue('');
  await expect(results(page)).toHaveCount(0);
  await expect(box).toBeFocused();
});

test('the keyboard reaches the matches: Down into them, Up back out, Enter picks, Escape clears', async ({ page }) => {
  await page.goto('/#provision');
  const box = page.getByRole('searchbox', { name: 'Search Space' });
  await box.fill('b');
  await box.press('ArrowDown');
  await expect(results(page).first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(box).toBeFocused();

  await box.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(results(page).nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();

  // Enter in the box picks the first match.
  await box.fill('amster');
  await box.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Space', exact: true })).toHaveValue('ipam/ip_space/a');
});

test('more than 50 matches: 50 buttons, a line saying how many more, and the dropdown still holds all of them', async ({ page }) => {
  const many = { spaces: Array.from({ length: 120 }, (_, i) => ({ id: `ipam/ip_space/s${i}`, name: `Site ${i}` })) };
  await page.route('**/api/ipam/spaces*', (route) => json(route, many));
  await page.goto('/#provision');
  await page.getByRole('searchbox', { name: 'Search Space' }).fill('site');
  await expect(results(page)).toHaveCount(50);
  await expect(page.getByRole('status').filter({ hasText: 'Showing 50 of 120 matches.' })).toBeVisible();
  await expect(options(page, 'Space')).toHaveCount(121); // placeholder + all 120
});

test('on a wide screen the caption sits beside its field; on a phone it sits above', async ({ page }) => {
  const geometry = async () => {
    const cap = await page.locator('[data-panel-id="provision-subnet-request"] [data-field]').first().locator(':scope > span').first().boundingBox();
    const ctl = await page.getByRole('searchbox', { name: 'Search Space' }).boundingBox();
    return { cap: cap!, ctl: ctl! };
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#provision');
  let g = await geometry();
  expect(g.ctl.x).toBeGreaterThan(g.cap.x + g.cap.width);
  expect(Math.abs(g.ctl.y - g.cap.y)).toBeLessThan(12);

  await page.setViewportSize({ width: 390, height: 844 });
  g = await geometry();
  expect(g.ctl.y).toBeGreaterThan(g.cap.y + g.cap.height - 1);
});

test('Editor fields sit beside their captions on a wide screen too', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#editor');
  const row = page.locator('[data-panel-id="editor-object-form"] [data-field]').first();
  const cap = await row.locator(':scope > span').boundingBox();
  const ctl = await row.locator('input').boundingBox();
  expect(ctl!.x).toBeGreaterThan(cap!.x + cap!.width);
});

test('a block search belongs to its space: changing the space clears it, and no old block can be picked', async ({ page }) => {
  await page.route('**/api/ipam/blocks*', (route) => {
    const space = new URL(route.request().url()).searchParams.get('space');
    const blocks = space === 'ipam/ip_space/a'
      ? [{ id: 'ipam/address_block/a1', name: 'Amsterdam Block' }]
      : [{ id: 'ipam/address_block/b1', name: 'Berlin Block' }];
    return json(route, { blocks });
  });
  await page.goto('/#provision');
  const space = page.getByRole('combobox', { name: 'Space', exact: true });
  const blockBox = page.getByRole('searchbox', { name: 'Search Block' });
  await space.selectOption({ label: 'Amsterdam Lab' });
  await blockBox.fill('block');
  await expect(results(page, 'block')).toHaveText(['Amsterdam Block']);

  await space.selectOption({ label: 'Berlin Office' });
  await expect(blockBox).toHaveValue('');
  await expect(results(page, 'block')).toHaveCount(0);

  await space.selectOption({ label: 'Select a space' });
  await expect(blockBox).toBeDisabled();
  await expect(results(page, 'block')).toHaveCount(0);
});

test('a form panel resized narrower stacks its rows instead of spilling out', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#provision');
  const form = page.locator('[data-panel-id="provision-subnet-request"] [data-form-cols]');
  await form.evaluate((el) => { (el as HTMLElement).style.width = '420px'; });
  const cap = await page.locator('[data-panel-id="provision-subnet-request"] [data-field]').first().locator(':scope > span').first().boundingBox();
  const ctl = await page.getByRole('searchbox', { name: 'Search Space' }).boundingBox();
  const box = await form.boundingBox();
  expect(ctl!.y).toBeGreaterThan(cap!.y + cap!.height - 1);
  expect(ctl!.x + ctl!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
});
