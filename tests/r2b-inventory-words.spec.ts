import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 2, job r2b: the Inventory pages (Network, DNS, Infra,
// Assets). Each test names the finding it pins.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

async function fail(page: Page, ...globs: string[]) {
  for (const g of globs) await page.route(g, (r) => r.fulfill({ status: 503, body: '' }));
}
// Every read a page makes, as in the audit's "fail" screenshots.
const ALL_READS = ['**/api/data*', '**/api/csp/**', '**/api/dns-analytics*', '**/api/host-metrics*', '**/api/hub/**', '**/api/ipam/**'];

const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);
const strip = (page: Page) => page.getByRole('list', { name: 'Headline numbers' });

test('R2-B1 R2-B5 B4: DNS with every read down blames no one panel and shows bare dashes', async ({ page }) => {
  await fail(page, ...ALL_READS);
  await page.goto('/#dns');
  await expect(page.locator('[data-updated]')).toContainText('Information is unavailable');
  await expect(page.locator('[data-updated]')).not.toContainText('Zone information');
  await expect(strip(page)).not.toContainText('Unavailable');
  // Zone problems: the message sits under the title, not at the panel's foot.
  const zp = panel(page, 'dns-zone-kpis');
  const msg = zp.getByText('DNS zone information is unavailable');
  await expect(msg).toBeVisible();
  const [cardTop, msgTop] = await Promise.all([zp.evaluate((e) => e.getBoundingClientRect().top), msg.evaluate((e) => e.getBoundingClientRect().top)]);
  expect(msgTop - cardTop).toBeLessThan(120);
});

test('B2: a wholly failed DNS or DHCP read shows the error, not a column of "not checked"', async ({ page }) => {
  await fail(page, '**/api/csp/dns-failures*', '**/api/csp/dhcp-requests*');
  await page.goto('/#dns');
  const failed = panel(page, 'dns-failed-lookups');
  await expect(failed.getByText("Couldn't read these numbers from Infoblox.")).toBeVisible();
  await expect(failed).not.toContainText('not checked');
  await page.goto('/#network');
  const dhcp = panel(page, 'network-dhcp-requests');
  await expect(dhcp.getByText("Couldn't read these numbers from Infoblox.")).toBeVisible();
  await expect(dhcp).not.toContainText('not checked');
});

test('B10 B15: DNS names its answers and panels in plain words and has an intro', async ({ page }) => {
  await page.goto('/#dns');
  // The intro line every other Inventory page has, under the title.
  await expect(page.locator('main p.text-copy.text-muted').first()).toBeVisible();
  const text = await page.locator('main').innerText();
  for (const word of ['(NXDOMAIN)', '(SERVFAIL)', '(REFUSED)', '\nDNSSEC\n', '\nRPZ\n', '\nDTC\n']) expect(text, word).not.toContain(word);
});

test('B10 B15: Network says IP spaces, not IPAM, and a failed count is not "count unavailable"', async ({ page }) => {
  await page.goto('/#network');
  await expect(panel(page, 'network-ipam-spaces')).toBeVisible();
  expect(await page.locator('main').innerText()).not.toMatch(/\bIPAM\b/);
  await fail(page, '**/api/data', '**/api/csp/ipam-util*');
  await page.reload();
  await expect(page.getByText('IP space information is unavailable')).toBeVisible();
  expect(await page.locator('main').innerText()).not.toContain('count unavailable');
});

test('R2-B3 B8: Infra says each healthy state one way, in green, and Review for degraded', async ({ page }) => {
  await page.goto('/#infra');
  const hosts = panel(page, 'infra-host-inventory');
  const active = hosts.getByText('Active', { exact: true }).first();
  await expect(active).toBeVisible();
  const completed = panel(page, 'infra-jobs').getByText('Completed', { exact: true });
  await expect(completed).toBeVisible();
  const bg = (l: typeof active) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await bg(active)).toBe(await bg(completed));
  const dfp = panel(page, 'infra-dfp-services').getByText('Online', { exact: true });
  await expect(dfp).toBeVisible();
  expect(await bg(dfp)).toBe(await bg(completed));
  const svc = panel(page, 'infra-service-health');
  await expect(svc.getByText('Healthy', { exact: true })).toBeVisible();
  await expect(svc.getByText('Review', { exact: true })).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/degraded/i);
  expect(text).not.toMatch(/\bDFP\b/);
  await expect(strip(page)).toContainText('Review');
});

test('B2 R2-B5: Infra with its reads down says so once, without "not checked" or a lone "unavailable"', async ({ page }) => {
  await fail(page, ...ALL_READS);
  await page.goto('/#infra');
  await expect(panel(page, 'infra-host-status').getByText("CPU and memory couldn't be read from Infoblox.")).toBeVisible();
  await expect(panel(page, 'infra-host-status')).not.toContainText('not checked');
  await expect(strip(page)).not.toContainText('unavailable');
});

test('R2-B2 R2-B8: Assets names its types plainly when they fail', async ({ page }) => {
  await page.goto('/#assets');
  await expect(strip(page)).toContainText('Types');
  await expect(strip(page)).not.toContainText('Asset types');
  await fail(page, '**/api/csp/asset-filters*');
  await page.reload();
  await expect(page.getByText('Asset types unavailable')).toBeVisible();
  expect(await page.locator('main').innerText()).not.toContain('Asset filter information');
});

test('B2 (review): Infra says when the DNS readings fail even though CPU and memory arrived', async ({ page }) => {
  await fail(page, '**/api/csp/dns-health*');
  await page.goto('/#infra');
  const load = panel(page, 'infra-host-status').locator('[data-host-load]');
  await expect(load).toContainText('CPU and memory, latest reading');
  const line = load.locator('[data-host-dns-failed]');
  await expect(line).toContainText("DNS answer time and timeouts couldn't be read from Infoblox.");
  await expect(line.getByRole('button', { name: 'Try again' })).toBeVisible();
  // The failed DNS readings are not also listed as "not checked". (A host's own
  // missing memory reading in the table above still says "not checked".)
  await expect(load.locator('[data-host-dns]')).toHaveCount(0);
});
