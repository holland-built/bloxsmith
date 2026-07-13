import { test, expect } from '@playwright/test';

// Feature 10 — "?" keyboard-shortcut overlay. A global "?" opens a focus-trapped
// modal listing every app shortcut, including the verbs shipped across this plan:
// vim-nav (j/k/g/G/x/Enter//), pivot-on-cell (Menu key), multi-sort (Shift+click),
// copy-as, and copy-link. Esc closes and returns focus. Plain-text rows, neutral.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const WRAP = 'div[tabindex="0"]:has(tr.clickable)';

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 80, site: 'DR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

async function mock(page: any) {
  await page.route('**/api/data', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
}

test('"?" opens a focus-trapped shortcut overlay', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(`${WRAP} tr.clickable`).first()).toBeVisible();

  await page.keyboard.press('?');

  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  // Focus lands inside the dialog (focus trap).
  const focusInside = await dialog.evaluate((el) => el.contains(document.activeElement));
  expect(focusInside).toBe(true);
});

test('overlay lists the new verbs shipped in this plan', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(`${WRAP} tr.clickable`).first()).toBeVisible();

  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();

  await expect(dialog).toContainText('j');           // vim-nav
  await expect(dialog).toContainText('G');           // jump to bottom
  await expect(dialog).toContainText('Shift');       // multi-sort (Shift+click)
  await expect(dialog).toContainText('Copy as');     // copy-as
  await expect(dialog).toContainText('Copy link');   // copy-link
  await expect(dialog).toContainText(/pivot/i);      // pivot-on-cell
});

test('Esc closes the overlay and returns focus to where it was', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  const wrap = page.locator(WRAP);
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();

  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Focus returns to the table wrapper that had it before opening.
  const returned = await wrap.evaluate((el) => el === document.activeElement);
  expect(returned).toBe(true);
});

test('"?" typed inside an input does not open the overlay', async ({ page }) => {
  await mock(page);
  await page.goto('/#network');
  await expect(page.locator(`${WRAP} tr.clickable`).first()).toBeVisible();

  const filter = page.locator('.dt-filter');
  await filter.focus();
  await page.keyboard.press('?');

  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  await expect(filter).toHaveValue('?');
});
