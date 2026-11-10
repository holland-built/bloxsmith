import { test, expect } from './fixtures';

// The Best practices page lists design problems first, then the checks it
// couldn't tell, then the ones that passed. A check that couldn't see all its
// data never shows as passed.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const checks = [
  { id: 'dhcp-aap', severity: 'medium', status: 'passed', title: 'No DHCP HA group uses Advanced Active/Passive', why: 'x', items: [] },
  {
    id: 'gm-resilience', severity: 'high', status: 'unknown', title: 'Grid Masters with no HA and no candidate', why: 'x', items: [],
    reason: "2 grids couldn't be checked: not all of their members are visible in the Portal, so a candidate may exist.",
  },
  {
    id: 'hosts-down', severity: 'high', status: 'problem', title: '2 on-prem hosts are offline or in error',
    why: "A host that's down serves nothing.", link: '#infra',
    items: [{ name: 'nios-x-dal-3', detail: 'offline' }, { name: 'nios-x-lon-2', detail: 'error' }],
  },
];

test('problems come first and open to show what is affected; the rest say passed or couldn\'t tell', async ({ page }) => {
  await page.route('**/api/best-practices', (r) => r.fulfill(json({ checks })));
  await page.goto('/#best-practices');
  await expect(page.getByRole('heading', { level: 1, name: 'Best practices' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Best practice checks' });
  const rows = list.locator(':scope > li');
  await expect(rows).toHaveCount(3);
  // The count leads the row, ahead of the sentence, and is said once.
  await expect(rows.nth(0)).toContainText('2 on-prem hosts are offline or in error');
  await expect(rows.nth(0).locator('.bp-count')).toHaveText('2');
  await expect(rows.nth(0).locator('.bp-title')).toHaveText('on-prem hosts are offline or in error');
  await expect(rows.nth(0)).toContainText('High');
  await expect(rows.nth(1)).toContainText("Grid Masters with no HA and no candidateCouldn't tell");
  await expect(rows.nth(1)).toContainText('not all of their members are visible');
  await expect(rows.nth(2)).toContainText('No DHCP HA group uses Advanced Active/PassivePassed');

  const affected = page.getByRole('list', { name: '2 on-prem hosts are offline or in error' });
  await expect(affected).toBeHidden();
  await rows.nth(0).locator('summary').click();
  await expect(affected.getByRole('listitem')).toHaveText(['nios-x-dal-3offline', 'nios-x-lon-2error']);
  await expect(rows.nth(0).getByRole('link', { name: 'Open Infra' })).toHaveAttribute('href', '#infra');
});

test('the headline numbers come first: to fix, couldn\'t tell and passed, each out of the checks run', async ({ page }) => {
  await page.route('**/api/best-practices', (r) => r.fulfill(json({ checks })));
  await page.goto('/#best-practices');
  const glance = page.getByRole('region', { name: 'Checks at a glance' });
  const num = (t: string) => glance.locator(`[data-tile="${t}"] .bp-num`);
  await expect(num('fix')).toHaveText('1 of 3');
  await expect(glance.locator('[data-tile="fix"]')).toContainText('1 high');
  await expect(num('unknown')).toHaveText('1 of 3');
  await expect(num('passed')).toHaveText('1 of 3');
  // One cell per check, in list order; the one that couldn't tell is its own state.
  await expect(glance.locator('.bp-cell')).toHaveCount(3);
  await expect(glance.locator('.bp-cell').nth(1)).toHaveClass(/unknown/);
});

test('Help opens the section for this page', async ({ page }) => {
  await page.route('**/api/best-practices', (r) => r.fulfill(json({ checks })));
  await page.goto('/#best-practices');
  await page.getByRole('button', { name: 'Help for this page' }).click();
  await expect(page.getByRole('dialog')).toContainText('Help: Best practices');
  await expect(page.getByRole('dialog')).toContainText('A check never says passed when it couldn');
});

test('with the backend unreachable, no check claims to have passed', async ({ page }) => {
  // The e2e server points at an address that never answers, so every read fails.
  await page.goto('/#best-practices');
  const list = page.getByRole('list', { name: 'Best practice checks' });
  await expect(list.locator(':scope > li')).toHaveCount(4);
  await expect(list).not.toContainText('Passed');
  await expect(list.getByText("Couldn't tell")).toHaveCount(4);
  const glance = page.getByRole('region', { name: 'Checks at a glance' });
  await expect(glance.locator('[data-tile="passed"] .bp-num')).toHaveText('0 of 4');
  await expect(glance.locator('[data-tile="unknown"] .bp-num')).toHaveText('4 of 4');
});
