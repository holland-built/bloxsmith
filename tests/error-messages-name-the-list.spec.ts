import { test, expect } from './fixtures';
import { openTask } from './page-fixtures';

// Fix 4 (owner, 2026-11-24): error and empty messages say what failed.
// - Each failed list names itself, and shows the reason the server gave.
// - A "pick X and press Y" line that cannot be followed says which list did not load.
// - Best practices with no checks says so, and its tiles say unavailable, not 0.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const UPSTREAM = { error: 'Infoblox request failed', status: 500, upstream: 'Rate limit exceeded' };

test('Get an address: each failed list says which list it is and why', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json(UPSTREAM, 502)));
  await page.route('**/api/dns/zones*', (r) => r.fulfill(json({ zones: [] })));
  await page.goto('/#selfservice');

  const card = await openTask(page, 'address');
  await expect(card.getByText('Could not load IP spaces. Infoblox said: Rate limit exceeded.')).toBeVisible();
  await expect(card.getByText(/could not load current data/i)).toHaveCount(0);
  // The instruction beside the form cannot be followed, so it says why.
  await expect(card.getByText('IP spaces did not load, so there is nothing to pick yet.')).toBeVisible();
  await expect(card.getByText(/Pick a space and press Preview/)).toHaveCount(0);
});

test('Drift: failed templates replace "Pick a template and press Compare"', async ({ page }) => {
  await page.route('**/api/templates*', (r) => r.fulfill(json({ error: 'templates folder missing' }, 500)));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [] })));
  await page.goto('/#drift');

  await expect(page.locator('[data-drift-form]').getByText('Could not load site templates. templates folder missing.')).toBeVisible();
  const result = page.locator('[data-drift-result]');
  await expect(result.getByText('Site templates did not load, so there is nothing to pick yet.')).toBeVisible();
  await expect(result.getByText(/Pick a template and press Compare/)).toHaveCount(0);
});

test('Drift: with templates loaded, the instruction is still shown', async ({ page }) => {
  await page.route('**/api/templates*', (r) => r.fulfill(json([{ name: 'dal', region: 'us', environment: 'prod' }])));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [] })));
  await page.goto('/#drift');
  await expect(page.locator('[data-drift-result]').getByText(/Pick a template and press Compare/)).toBeVisible();
});

test('Best practices: no checks back says "No checks ran" and the tiles are unavailable, never 0 of 0', async ({ page }) => {
  await page.route('**/api/best-practices', (r) => r.fulfill(json({ checks: [] })));
  await page.goto('/#best-practices');

  await expect(page.getByText('No checks ran, so nothing here is known to pass or fail.')).toBeVisible();
  const tiles = page.getByRole('region', { name: 'Checks at a glance' });
  await expect(tiles).not.toContainText('of 0');
  await expect(tiles.getByText('unavailable')).toHaveCount(3);
  await expect(tiles.getByText('none', { exact: true })).toHaveCount(0);
});
