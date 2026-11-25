import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 3, job r3x: the Inventory pages (Network, DNS, Infra,
// Assets). Each test names the finding it pins.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const SHELL = new Set(['/api/brand', '/api/update/check', '/api/vault/status', '/api/views', '/api/vault/write-target']);
// Every read 503 with no body, as in the audit's "fail" screenshots.
async function failAll(page: Page) {
  await page.route('**/api/**', (r) => (SHELL.has(new URL(r.request().url()).pathname) ? r.fallback() : r.fulfill({ status: 503, body: '' })));
}
const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);

// R3-B2: one look and one wording for a failed panel. Every failed panel on
// these pages names itself by its own title ("<title> unavailable", the
// pattern FeedCard already uses), always says why, and a part-failed panel's
// line is body size with the standard Try again.
for (const id of ['network', 'dns', 'infra', 'assets']) {
  test(`R3-B2: every failed panel on ${id} is "<its title> unavailable" with a reason`, async ({ page }) => {
    test.setTimeout(60_000);
    await failAll(page);
    await page.goto(`/#${id}`);
    await expect(page.locator('main h1').first()).toBeVisible();
    // Past the page's own retries (2s and 8s), so the final state shows.
    await page.waitForTimeout(12_000);
    const found = await page.locator('[data-feed-unavailable]').evaluateAll((els) => els.map((el) => {
      const card = el.closest('[data-panel-id]');
      const title = card?.querySelector('h2')?.textContent ?? '';
      return {
        label: el.getAttribute('data-feed-unavailable'),
        title: title.split(' — ')[0].trim(),
        reason: !!el.querySelector('[data-failure-reason]'),
      };
    }));
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      // Two exceptions, each named: a question can't take "unavailable"
      // after it, and Discovery connections is drawn by a shared component
      // (components/AssetConnectors.jsx) this job does not own.
      if (f.title === 'Which Subnets Run Out First?') { expect(f.label).toBe('Subnets unavailable'); expect(f.reason).toBe(true); continue; }
      if (f.title === 'Discovery connections') continue;
      expect(f.label, `label under "${f.title}"`).toBe(`${f.title} unavailable`);
      expect(f.reason, `reason under "${f.title}"`).toBe(true);
    }
  });
}

test('R3-B2: a part-failed panel line is body size with the standard Try again', async ({ page }) => {
  await page.route('**/api/csp/dns-failures*', (r) => r.fulfill({ status: 503, body: '' }));
  await page.route('**/api/csp/dhcp-requests*', (r) => r.fulfill({ status: 503, body: '' }));
  await page.route('**/api/host-metrics*', (r) => r.fulfill({ status: 503, body: '' }));
  for (const [hash, id, sel] of [
    ['dns', 'dns-failed-lookups', '[data-panel-failed]'],
    ['network', 'network-dhcp-requests', '[data-panel-failed]'],
    ['infra', 'infra-host-status', '[data-panel-failed]'],
  ]) {
    await page.goto(`/#${hash}`);
    const line = panel(page, id).locator(sel);
    await expect(line, id).toBeVisible();
    const size = await line.evaluate((e) => getComputedStyle(e).fontSize);
    expect(size, `${id} line`).toBe('14px');
    const btn = line.getByRole('button', { name: 'Try again' });
    await expect(btn, id).toBeVisible();
    expect(await btn.evaluate((e) => getComputedStyle(e).fontSize), `${id} button`).toBe('14px');
  }
});

test('R3-B3: Infra "Discovered assets" counts the same assets as the Assets page', async ({ page }) => {
  await page.goto('/#assets');
  const strip = page.getByRole('list', { name: 'Headline numbers' });
  const tile = strip.getByRole('button', { name: /^Assets [\d,]+$/ });
  await expect(tile).toBeVisible();
  const n = (await tile.getAttribute('aria-label') ?? await tile.innerText()).match(/[\d,]+/)?.[0];
  expect(n).toBeTruthy();
  await page.goto('/#infra');
  await expect(page.getByRole('list', { name: 'Headline numbers' }).getByRole('listitem').filter({ hasText: 'Discovered assets' })).toContainText(n!);
});

test('R3-B4: DNS cache times say their unit in plain words', async ({ page }) => {
  await page.goto('/#dns');
  const zones = panel(page, 'dns-zones');
  await expect(zones).toContainText('5 minutes');
  await expect(panel(page, 'dns-dtc-lbdn')).toContainText('5 minutes');
  for (const id of ['dns-zones', 'dns-dtc-lbdn']) {
    const cells = await panel(page, id).locator('td').allInnerTexts();
    expect(cells.map((c) => c.trim()), id).not.toContain('300');
  }
});

test('B10: DNS and Assets drop the leftover jargon', async ({ page }) => {
  await page.goto('/#dns');
  await expect(panel(page, 'dns-rpz')).toBeVisible();
  const dns = await page.locator('main').innerText();
  for (const w of ['Precedence', 'Override']) expect(dns, w).not.toContain(w);
  // Codex review: the server group stays, so a service still says which group it is in.
  const services = panel(page, 'dns-services');
  await expect(services.getByRole('columnheader', { name: 'Server group' })).toBeVisible();
  await expect(services.getByRole('cell', { name: 'pool/baseline-1' })).toBeVisible();
  // Blocklist "Type local" is now "Source: Your own list".
  const rpzCells = (await panel(page, 'dns-rpz').locator('td').allInnerTexts()).map((c) => c.trim());
  expect(rpzCells).not.toContain('local');
  expect(rpzCells).toContain('Your own list');
  await page.goto('/#assets');
  await expect(panel(page, 'assets-list')).toBeVisible();
  const assets = await page.locator('main').innerText();
  expect(assets).not.toMatch(/\bMAC\b/);
  await expect(page.getByRole('textbox', { name: /Search assets/ })).toHaveAttribute('aria-label', /hardware \(MAC\) address/);
});

test('B12: the Assets search box sits in the same panel as the list it fills', async ({ page }) => {
  await page.goto('/#assets');
  const list = panel(page, 'assets-list');
  await expect(list.getByRole('textbox', { name: /Search assets/ })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Search' })).toBeVisible();
});
