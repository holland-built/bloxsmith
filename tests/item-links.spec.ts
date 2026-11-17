import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Names in tables are links to that item's own page (#dossier?kind=…), which
// shows its details and what you can do next. Every /api/ answer is faked from
// tests/page-fixtures.ts, including /api/item/*.
//
// Each test clicks a name in a real tab and checks two things: the link
// carried what identifies the item (kind, value and, where the row knows it,
// the real id), and the page that opened shows that item's own details.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// The /api/item request the item page made, so a test can check it asked for
// the right thing rather than only that the fake answer was drawn.
function itemRequests(page: import('@playwright/test').Page) {
  const seen: URL[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/item/')) seen.push(u);
  });
  return seen;
}

test('a network name opens the network page, read by its id', async ({ page }) => {
  const seen = itemRequests(page);
  await page.goto('/#network');
  const link = page.locator('a[data-item-link="network"]', { hasText: '10.30.0.0' }).first();
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/#dossier\?kind=network&q=10\.30\.0\.0%2F24&id=ipam%2Fsubnet%2Fbaseline-3/);
  const item = page.locator('[data-item-page="network"]');
  await expect(item.locator('[data-item-details]')).toContainText('baseline-net-c');
  await expect(item.locator('[data-item-details]')).toContainText('Baseline Space');
  await expect(item.locator('[data-item-details]')).toContainText('98% used');
  await expect(item.getByRole('link', { name: 'Open in Editor' })).toHaveAttribute('href', '#editor?type=subnet&id=ipam%2Fsubnet%2Fbaseline-3&q=10.30.0.0');
  await expect(item.getByRole('button', { name: 'Copy' })).toBeVisible();
  expect(seen.some((u) => u.pathname === '/api/item/network' && u.searchParams.get('id') === 'ipam/subnet/baseline-3')).toBe(true);
});

test('a zone name opens the zone page with its DNS view', async ({ page }) => {
  const seen = itemRequests(page);
  await page.goto('/#dns');
  const link = page.locator('a[data-item-link="zone"]', { hasText: 'baseline.example.' }).first();
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/#dossier\?kind=zone&q=baseline\.example\./);
  const details = page.locator('[data-item-page="zone"] [data-item-details]');
  await expect(details).toContainText('baseline-view');
  await expect(details).toContainText('baseline zone');
  await expect(page.locator('[data-item-page="zone"]').getByRole('link', { name: 'Open in Editor' })).toHaveAttribute('href', /type=dns_zone&id=dns%2Fauth_zone%2Fbaseline-1/);
  expect(seen.some((u) => u.pathname === '/api/item/zone' && u.searchParams.get('id') === 'dns/auth_zone/baseline-1')).toBe(true);
});

test('an IP space name opens the space page', async ({ page }) => {
  const seen = itemRequests(page);
  await page.goto('/#network');
  const link = page.locator('a[data-item-link="space"]', { hasText: 'Baseline Space' }).first();
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/#dossier\?kind=space&q=Baseline\+Space&id=ipam%2Fip_space%2Fbaseline-1/);
  const details = page.locator('[data-item-page="space"] [data-item-details]');
  await expect(details).toContainText('the main space');
  await expect(details).toContainText('42% used');
  // A space has no Editor form, so Copy is the only action.
  await expect(page.locator('[data-item-page="space"]').getByRole('link', { name: 'Open in Editor' })).toHaveCount(0);
  expect(seen.some((u) => u.pathname === '/api/item/space')).toBe(true);
});

test('an address opens its search page with what IPAM holds for it', async ({ page }) => {
  await page.goto('/#network');
  const link = page.locator('a[data-item-link="address"]', { hasText: '10.10.0.5' }).first();
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/#dossier\?kind=address&q=10\.10\.0\.5/);
  await expect(page.getByRole('textbox', { name: 'Search everything' })).toHaveValue('10.10.0.5');
  const ipam = page.locator('[data-dossier-source="ipam"]');
  await expect(ipam).toHaveAttribute('data-dossier-state', 'ok');
  await expect(ipam).toContainText('10.10.0.5');
  await expect(ipam).toContainText('used');
  await expect(page.locator('[data-item-actions]').getByRole('button', { name: 'Copy' })).toBeVisible();
});

test('a site name opens the site page listing its networks, each a link', async ({ page }) => {
  await page.goto('/#network');
  const link = page.locator('a[data-item-link="site"]', { hasText: 'baseline-site' }).first();
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/#dossier\?kind=site&q=baseline-site/);
  const nets = page.locator('[data-item-page="site"] [data-item-networks]');
  await expect(nets.locator('a[data-item-link="network"]')).toHaveText(['10.10.0.0/24', '10.20.0.0/24']);
});

test('an old #dossier?q= link with a network opens the network page', async ({ page }) => {
  await page.goto('/#dossier?q=10.30.0.0/24');
  await expect(page.locator('[data-item-page="network"] [data-item-details]')).toContainText('baseline-net-c');
});

// /api/item answers one page at a time (50 rows on a real tenant). These fake
// a two-row page of a three-row list, so the cut is visible with three rows.
const net = (n: number) => ({ id: `ipam/subnet/page-${n}`, address: `10.9.${n}.0`, cidr: 24, name: `page-net-${n}`, space: 'ipam/ip_space/baseline-1', space_name: 'Baseline Space' });
async function pagedItem(page: import('@playwright/test').Page, kind: string) {
  const offsets: string[] = [];
  await page.route(`**/api/item/${kind}?**`, (route) => {
    const off = new URL(route.request().url()).searchParams.get('offset');
    offsets.push(off ?? '');
    const body = off === '2'
      ? { availability: 'ok', rows: [net(3)], total: 3, limit: 2, offset: 2 }
      : { availability: 'ok', rows: [net(1), net(2)], total: 3, limit: 2, offset: 0 };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return offsets;
}

test('a site with more networks than one page says so and loads the rest', async ({ page }) => {
  const offsets = await pagedItem(page, 'site');
  await page.goto('/#dossier?kind=site&q=big-site');
  const item = page.locator('[data-item-page="site"]');
  await expect(item.locator('[data-item-details]')).toContainText('2 of 3');
  await expect(item.locator('[data-item-networks] a[data-item-link="network"]')).toHaveCount(2);
  await item.getByRole('button', { name: 'Show more' }).click();
  await expect(item.locator('[data-item-networks] a[data-item-link="network"]')).toHaveText(['10.9.1.0/24', '10.9.2.0/24', '10.9.3.0/24']);
  await expect(item.locator('[data-item-details]')).toContainText('3');
  await expect(item.locator('[data-item-details]')).not.toContainText('of 3');
  await expect(item.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  expect(offsets).toEqual(['', '2']);
});

test('the chooser says it is cut off and loads the rest', async ({ page }) => {
  await pagedItem(page, 'network');
  await page.goto('/#dossier?kind=network&q=10.9.0.0/16');
  const chooser = page.locator('[data-item-chooser]');
  await expect(chooser).toContainText('(2 of 3)');
  await expect(chooser.getByRole('link')).toHaveCount(2);
  await chooser.getByRole('button', { name: 'Show more' }).click();
  await expect(chooser.getByRole('link')).toHaveCount(3);
  await expect(chooser.getByRole('button', { name: 'Show more' })).toHaveCount(0);
});
