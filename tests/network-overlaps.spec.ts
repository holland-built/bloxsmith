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

const r = (prefix: string, id: string, kind = 'subnet') => ({ prefix, id, kind });
const groups = [
  {
    range: '192.168.0.0/16',
    spaces: 2,
    members: [
      { id: 's/a', name: 'Corp', prefixes: ['192.168.0.0/16'], ranges: [r('192.168.0.0/16', 'ipam/address_block/a2', 'address_block')] },
      { id: 's/b', name: 'Lab', prefixes: ['192.168.1.0/24'], ranges: [r('192.168.1.0/24', 'ipam/subnet/b2')] },
    ],
  },
  {
    range: '10.0.0.0/8',
    spaces: 3,
    members: [
      { id: 'ipam/ip_space/7cc1cfd4-aaaa', name: 'Corp Main', prefixes: ['10.0.0.0/8'], ranges: [r('10.0.0.0/8', 'ipam/address_block/a1', 'address_block')] },
      { id: 's/b', name: 'Lab', prefixes: ['10.1.0.0/16'], ranges: [r('10.1.0.0/16', 'ipam/subnet/b1')] },
      { id: 's/c', name: 'Branch', prefixes: ['10.2.0.0/16', '10.3.0.0/16'], ranges: [r('10.2.0.0/16', 'ipam/subnet/c1'), r('10.3.0.0/16', 'ipam/subnet/c2')] },
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
  for (const name of ['Corp Main', 'Lab', 'Branch']) await expect(list).toContainText(name);
  await expect(list).toContainText('10.2.0.0/16 (65,536 addresses), 10.3.0.0/16 (65,536 addresses)');

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

test('an open row links each space to the Infoblox Portal and each range to the Editor', async ({ page }) => {
  await page.route('**/api/ipam/overlaps', (route) =>
    route.fulfill({ json: { status: 'ok', groups, portal: 'https://csp.eu.infoblox.com' } }),
  );
  await page.goto('/#network');
  const rows = panel(page).getByRole('button', { name: /spaces$/ });
  await rows.nth(0).click();
  const list = panel(page).locator('[data-overlap-spaces]');

  // The space: this server's own Portal host and the space's uuid.
  const corp = list.getByRole('link', { name: 'Corp Main in Infoblox (opens in a new tab)' });
  await expect(corp).toHaveAttribute(
    'href',
    'https://csp.eu.infoblox.com/#/perspective/ipam/address_space/ipam/ip_space/7cc1cfd4-aaaa',
  );
  await expect(corp).toHaveAttribute('target', '_blank');
  await expect(corp).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(list.getByRole('link', { name: /in Infoblox/ })).toHaveCount(3);

  // Each range: the Editor, that object's kind and id, searched by its address.
  await expect(list.getByRole('link', { name: /^10\.0\.0\.0\/8 \(16,777,216 addresses\), open this address block in the Editor$/ })).toHaveAttribute(
    'href',
    '#editor?type=address_block&id=ipam%2Faddress_block%2Fa1&q=10.0.0.0',
  );
  await expect(list.getByRole('link', { name: /^10\.3\.0\.0\/16 \(65,536 addresses\), open this subnet in the Editor$/ })).toHaveAttribute(
    'href',
    '#editor?type=subnet&id=ipam%2Fsubnet%2Fc2&q=10.3.0.0',
  );
  await expect(list.getByRole('link', { name: /in the Editor$/ })).toHaveCount(4);
  await expect(list.getByRole('link', { name: /in the Editor$/ }).first()).not.toHaveAttribute('target', /.+/);
});

test('with no portal from the server the space link uses csp.infoblox.com', async ({ page }) => {
  await page.route('**/api/ipam/overlaps', (route) => route.fulfill({ json: { status: 'ok', groups } }));
  await page.goto('/#network');
  await panel(page).getByRole('button', { name: /spaces$/ }).nth(1).click();
  await expect(panel(page).getByRole('link', { name: 'Lab in Infoblox (opens in a new tab)' })).toHaveAttribute(
    'href',
    'https://csp.infoblox.com/#/perspective/ipam/address_space/ipam/ip_space/b',
  );
});

test('following a subnet link opens the Editor with that subnet picked', async ({ page }) => {
  await page.route('**/api/ipam/overlaps', (route) => route.fulfill({ json: { status: 'ok', groups } }));
  const finds: string[] = [];
  await page.route('**/api/edit/subnet/find*', (route) => {
    finds.push(new URL(route.request().url()).searchParams.get('q') || '');
    return route.fulfill({ json: { items: [
      { id: 'ipam/subnet/other', label: '10.3.0.0/16 — elsewhere', fields: { block_id: 'ipam/address_block/z', cidr: 16, name: 'elsewhere', comment: '', tags: '' } },
      { id: 'ipam/subnet/c2', label: '10.3.0.0/16 — branch-lan', fields: { block_id: 'ipam/address_block/9', cidr: 16, name: 'branch-lan', comment: 'floor 2', tags: '' } },
    ] } });
  });
  await page.goto('/#network');
  await panel(page).getByRole('button', { name: /spaces$/ }).nth(0).click();
  await panel(page).getByRole('link', { name: /^10\.3\.0\.0\/16 \(65,536 addresses\), open this subnet/ }).click();

  await expect(page.getByRole('heading', { name: 'Change this subnet' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByPlaceholder('Find by name, comment or full network address')).toHaveValue('10.3.0.0');
  await expect(page.getByRole('button', { name: '10.3.0.0/16 — branch-lan' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '10.3.0.0/16 — elsewhere' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('textbox', { name: 'Name (optional)' })).toHaveValue('branch-lan');
  await expect(page.getByRole('textbox', { name: 'Comment (optional)' })).toHaveValue('floor 2');
  await expect(page.getByRole('combobox', { name: 'Address block' })).toHaveValue('ipam/address_block/9');
  await expect(page.getByRole('button', { name: 'Delete Subnet' })).toBeVisible();
  expect(finds).toEqual(['10.3.0.0']);
});
