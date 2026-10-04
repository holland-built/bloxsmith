import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import type { Page } from '@playwright/test';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// TWO OVERLAYS THAT A KEYBOARD COULD OPEN AND THEN NOT USE.
//
// The Incidents action drawer covered the page with a scrim but was a plain
// div: no dialog role, focus stayed on the row behind it, Tab kept walking the
// queue under the scrim, and Escape did nothing. The header's tenant list said
// `role="listbox"` and answered to none of a listbox's keys: focus stayed on
// the chip, the arrow keys scrolled the page, and Escape did nothing.
//
// EVERY TEST HERE WAS RUN AGAINST v3.87.0 AND FAILED THERE, for the reason its
// name gives. The drawer tests find the panel through its heading rather than
// through `role="dialog"`, so the focus checks fail on the old code because
// focus is in the wrong place and not merely because the role is missing.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// ---------- Incidents action drawer ----------

const ACTION = 'Baseline suspicious domain';

async function openDrawerByKeyboard(page: Page) {
  await page.goto('/#incidents');
  const row = page.getByRole('button', { name: ACTION });
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Action detail' })).toBeVisible();
  return row;
}

// Is focus inside the drawer's panel? The panel is the heading's grandparent
// (heading -> title row -> panel), which holds on the old markup too.
function focusInDrawer(page: Page) {
  return page.getByRole('heading', { name: 'Action detail' }).evaluate((h) => {
    const panel = h.parentElement!.parentElement!;
    return panel.contains(document.activeElement);
  });
}

test('the action drawer is a named dialog', async ({ page }) => {
  await openDrawerByKeyboard(page);
  const dialog = page.getByRole('dialog', { name: 'Action detail' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
});

test('opening the action drawer moves focus into it, and Tab stays there', async ({ page }) => {
  await openDrawerByKeyboard(page);
  await expect.poll(() => focusInDrawer(page)).toBe(true);

  // More presses than the drawer has controls, in both directions, so a trap
  // that only holds one end would let focus out.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await focusInDrawer(page), `after Tab ${i + 1}`).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await focusInDrawer(page), `after Shift+Tab ${i + 1}`).toBe(true);
  }
});

test('Escape closes the action drawer and returns focus to the row that opened it', async ({ page }) => {
  const row = await openDrawerByKeyboard(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Action detail' })).toHaveCount(0);
  await expect(row).toBeFocused();
});

// ---------- header tenant list ----------

// Three tenants with the MIDDLE one in use. With the first in use, "focus
// lands on the tenant in use" and "focus lands on the first row" would be the
// same observation, and so would Home.
const TENANTS = [
  { id: 't-one', label: 'Tenant One' },
  { id: 't-two', label: 'Tenant Two' },
  { id: 't-three', label: 'Tenant Three' },
];

async function openTenantList(page: Page) {
  await page.route('**/api/vault/status*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        active: 't-two',
        exists: true,
        ready: true,
        unlocked: true,
        vaultMode: false,
        hasGroq: false,
        llm: { base_url: '', hasKey: false, model: '' },
        tenants: TENANTS,
        update: { available: false, checkDisabled: false, current: 'v0.0.0-baseline', latest: 'v0.0.0-baseline', selfUpdate: false, url: '' },
        version: 'v0.0.0-baseline',
        writeAllowed: [],
      }),
    }),
  );
  await page.goto('/#overview');
  const chip = page.locator('button[aria-haspopup="listbox"]');
  await expect(chip).toBeVisible();
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  return chip;
}

const option = (page: Page, label: string) => page.getByRole('option', { name: label });

test('opening the tenant list puts focus on the tenant in use', async ({ page }) => {
  await openTenantList(page);
  await expect(option(page, 'Tenant Two')).toBeFocused();
});

test('arrow keys, Home and End move through the tenant list', async ({ page }) => {
  await openTenantList(page);
  // Focus is PUT on the tenant in use here rather than expected there, so this
  // test fails on the old code for the keys and not for where focus started.
  await option(page, 'Tenant Two').focus();

  await page.keyboard.press('ArrowDown');
  await expect(option(page, 'Tenant Three')).toBeFocused();
  // The end of the list is the end: no wrap to the top.
  await page.keyboard.press('ArrowDown');
  await expect(option(page, 'Tenant Three')).toBeFocused();

  await page.keyboard.press('Home');
  await expect(option(page, 'Tenant One')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(option(page, 'Tenant One')).toBeFocused();

  await page.keyboard.press('End');
  await expect(option(page, 'Tenant Three')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(option(page, 'Tenant Two')).toBeFocused();
});

// The list is one stop in the tab order. On the old code Tab walked the rows
// one by one, and from the chip it landed on the invisible full-screen
// "Close tenant menu" button with the list still open.
for (const key of ['Tab', 'Shift+Tab']) {
  test(`${key} closes the tenant list and moves on from the chip`, async ({ page }) => {
    const chip = await openTenantList(page);
    await page.keyboard.press(key);
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(chip).not.toBeFocused();
    const landed = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    expect(landed).not.toBe('Close tenant menu');
  });
}

test('Escape closes the tenant list and returns focus to the chip', async ({ page }) => {
  const chip = await openTenantList(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(chip).toBeFocused();
});
