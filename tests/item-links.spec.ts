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
