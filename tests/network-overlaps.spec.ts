import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// "OVERLAPPING RANGES" on the Network page: one row per address range used by
// more than one IP space, the most spaces first. Opening a row lists each space
// with its own ranges, because a row is ranges that touch, not one range shared
// everywhere. A read the server could not show to be whole comes back as
// status:"error" with a plain sentence, and the card shows that sentence, never
// a list. go/internal/dashboard/overlaps_test.go is the server's half.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const panel = (page: import('@playwright/test').Page) => page.locator('[data-panel-id="network-overlaps"]');

const groups = [
  {
    range: '192.168.0.0/16',
    spaces: 2,
    members: [
      { id: 's/a', name: 'Corp', prefixes: ['192.168.0.0/16'] },
      { id: 's/b', name: 'Lab', prefixes: ['192.168.1.0/24'] },
    ],
  },
  {
    range: '10.0.0.0/8',
    spaces: 3,
    members: [
      { id: 's/a', name: 'Corp', prefixes: ['10.0.0.0/8'] },
      { id: 's/b', name: 'Lab', prefixes: ['10.1.0.0/16'] },
      { id: 's/c', name: 'Branch', prefixes: ['10.2.0.0/16', '10.3.0.0/16'] },
    ],
  },
];

test('rows come biggest first, and opening one lists each space with its own ranges', async ({ page }) => {
  // Served smallest first on purpose: the card must still put 10.0.0.0/8 (3 spaces) on top.
  await page.route('**/api/ipam/overlaps', (route) => route.fulfill({ json: { status: 'ok', groups } }));
  await page.goto('/#network');
  const rows = panel(page).getByRole('button', { name: /spaces$/ });
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(rows.nth(0)).toContainText('10.0.0.0/8');
  await expect(rows.nth(0)).toContainText('3 spaces');
  await expect(rows.nth(1)).toContainText('192.168.0.0/16');

  await expect(panel(page).locator('[data-overlap-spaces]')).toHaveCount(0);
  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
  const list = panel(page).locator('[data-overlap-spaces]');
  await expect(list).toBeVisible();
  for (const name of ['Corp', 'Lab', 'Branch']) await expect(list).toContainText(name);
  await expect(list).toContainText('10.2.0.0/16, 10.3.0.0/16');

  await rows.nth(0).click();
  await expect(list).toHaveCount(0);
});

test('a read that could not be shown whole shows the plain sentence, not a list', async ({ page }) => {
  await page.route('**/api/ipam/overlaps', (route) =>
    route.fulfill({ json: { status: 'error', error: "Couldn't read every subnet, so the list could be wrong." } }),
  );
  await page.goto('/#network');
  await expect(panel(page)).toContainText("Couldn't read every subnet, so the list could be wrong.", { timeout: 20_000 });
  await expect(panel(page).getByRole('button', { name: /spaces$/ })).toHaveCount(0);
  await expect(panel(page)).not.toContainText('No address range is used');
});

test('no shared range says so in words', async ({ page }) => {
  await page.route('**/api/ipam/overlaps', (route) => route.fulfill({ json: { status: 'ok', groups: [] } }));
  await page.goto('/#network');
  await expect(panel(page)).toContainText('No address range is used in more than one IP space.', { timeout: 20_000 });
});
