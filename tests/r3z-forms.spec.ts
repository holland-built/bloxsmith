import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Round 3 audit, change forms and Site lists (findings R3-D1 to R3-D4, R3-E1).

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// R3-D1: Get an address, Provision and Editor say "Subnet", so Automate does too.
test('Automate: Get an IP address asks for a subnet, not a network', async ({ page }) => {
  await page.route('**/api/desk/runs', (r) => r.fulfill(json({ runs: [] })));
  await page.route('**/api/desk/spaces', (r) => r.fulfill(json({ spaces: [
    { id: 'ipam/ip_space/a', name: 'Amsterdam Lab', yours: false, reason: '250 of 256 addresses free' } ] })));
  await page.route('**/api/ipam/subnets*', (r) => r.fulfill(json({ subnets: [
    { id: 'ipam/subnet/s2', address: '10.16.8.0', cidr: 24, name: 'office-b' } ] })));
  await page.goto('/#automate');
  await expect(page.getByText('The next free address in a subnet you pick')).toBeVisible({ timeout: 20_000 });
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job.getByRole('combobox', { name: 'Network' })).toHaveCount(0);
  await expect(job.getByText('To preview, pick a subnet.')).toBeVisible();
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await expect(job.getByRole('combobox', { name: 'Subnet' })).toBeEnabled();
});

// R3-D2: the policies load error sits under the Policy box, above Preview.
test('Site lists: "Could not load security policies" sits under the Policy box', async ({ page }) => {
  await page.route('**/api/lists/targets', (r) => r.fulfill({ status: 503, body: '' }));
  await page.route('**/api/lists/never-add', (r) => r.fulfill(json({ ok: true, sites: [] })));
  await page.goto('/#lists');
  const err = page.getByText('Could not load security policies.');
  await expect(err).toBeVisible({ timeout: 30_000 });
  const policy = await page.getByRole('combobox', { name: 'Policy', exact: true }).boundingBox();
  const action = await page.getByRole('combobox', { name: 'What the policy does with these sites' }).boundingBox();
  const at = await err.boundingBox();
  expect(at!.y).toBeGreaterThan(policy!.y);
  expect(at!.y).toBeLessThan(action!.y);
});

// R3-D3 / R3-E1: a disabled button looks like the disabled Preview beside it.
test('Site lists: disabled Save never-add list and Propose look like disabled Preview', async ({ page }) => {
  await page.route('**/api/lists/targets', (r) => r.fulfill(json({ ok: true, lists: [], policies: [], redirects: [] })));
  await page.route('**/api/lists/never-add', (r) => r.fulfill(json({ ok: true, sites: [] })));
  await page.goto('/#lists');
  const preview = page.getByRole('button', { name: 'Preview' });
  await expect(preview).toBeDisabled({ timeout: 20_000 });
  const dimColor = await preview.evaluate((b) => getComputedStyle(b).color);
  for (const name of ['Save never-add list', 'Propose changes every day']) {
    const b = page.getByRole('button', { name, exact: true });
    await expect(b).toBeDisabled();
    expect(await b.evaluate((el) => getComputedStyle(el).color), name).toBe(dimColor);
    expect(await b.evaluate((el) => getComputedStyle(el).cursor), name).toBe('not-allowed');
  }
});

// R3-D4: Editor's Preview is grey with a hint until the required boxes are filled.
test('Editor: Preview is off until the required boxes are filled, and says which', async ({ page }) => {
  await page.goto('/#editor');
  const preview = page.getByRole('button', { name: 'Preview' }).first();
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toBeDisabled();
  await expect(page.getByText('To preview, fill in the zone name and pick a DNS view.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Zone name' }).fill('lab.example.com.');
  await expect(page.getByText('To preview, pick a DNS view.')).toBeVisible();
});

test('Editor: when DNS views fail to load, Preview is off and says to load them', async ({ page }) => {
  await page.route('**/api/dns/zones*', (r) => r.fulfill({ status: 503, body: '' }));
  await page.goto('/#editor');
  await expect(page.getByText('Could not load DNS views.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('textbox', { name: 'Zone name' }).fill('lab.example.com.');
  await expect(page.getByRole('button', { name: 'Preview' }).first()).toBeDisabled();
  await expect(page.getByText('To preview, load the DNS views.')).toBeVisible();
});
