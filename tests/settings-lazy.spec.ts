import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Settings sheet is fetched the first time it is opened (App.jsx), which is
// what keeps #provision under tests/bundle-budget.spec.ts's budget. The page
// behind goes inert the moment Settings is clicked, so two things have to hold
// while that fetch is not instant:
//   - the wait is on screen and announced, not a dead page;
//   - a fetch that fails leaves a way out that does not need a reload.

const SETTINGS = { name: 'Settings', exact: true };
const SHEET_FILE = '**/assets/TenantManager-*.js';

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('the Settings sheet is not fetched until Settings is opened', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (/TenantManager-[^/]*\.js$/.test(r.url())) fetched.push(r.url());
  });
  await page.goto('/#overview');
  await expect(page.getByRole('button', SETTINGS)).toBeVisible();
  expect(fetched).toEqual([]);
  await page.getByRole('button', SETTINGS).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  expect(fetched).toHaveLength(1);
});

test('a slow Settings file says it is loading', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(SHEET_FILE, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/#overview');
  await page.getByRole('button', SETTINGS).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading settings…' })).toBeVisible();
  release();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Loading settings…')).toHaveCount(0);
});

test('a Settings file that cannot be fetched leaves a way out', async ({ page }) => {
  await page.route(SHEET_FILE, (route) => route.abort());
  await page.goto('/#overview');
  await page.getByRole('button', SETTINGS).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Settings could not load.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload the page' })).toBeFocused();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Settings could not load.')).toHaveCount(0);
  // The page is usable again: a header link works, which it would not inside
  // an inert tree.
  await page.getByRole('link', { name: 'Provision', exact: true }).click();
  await expect(page).toHaveURL(/#provision/);
});
