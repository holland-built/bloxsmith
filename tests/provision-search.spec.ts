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
