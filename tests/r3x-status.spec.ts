import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 3, job r3x: the Status pages (Overview, Daily, Best
// practices, Value). Each test names the finding it pins.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const SHELL = new Set(['/api/brand', '/api/update/check', '/api/vault/status', '/api/views', '/api/vault/write-target']);
async function failAll(page: Page) {
  await page.route('**/api/**', (r) => (SHELL.has(new URL(r.request().url()).pathname) ? r.fallback() : r.fulfill({ status: 503, body: '' })));
}
const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);

test('R3-A1: Overview shows where the rest of the DNS answers went, beside the success share', async ({ page }) => {
  await page.goto('/#overview');
  // The fixture: 62.1% success, 35.6% name not found, 1.6% failed.
  await expect(page.locator('[data-dns-health]').first()).toContainText('62%');
  const lines = await page.locator('[data-dns-health]').all();
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    await expect(line).toContainText('62%');
    await expect(line).toContainText(/Name not found\s*36%/);
    await expect(line).toContainText(/Failed\s*1\.6%/);
  }
});

test('R3-A2: Daily DNS zone issues names its count column', async ({ page }) => {
  await page.goto('/#daily');
  const p = panel(page, 'daily-dns-zone-issues');
  await expect(p.getByRole('columnheader', { name: 'Issues found' })).toBeVisible();
});

test('R3-A4: Daily hosts use the same status words as Overview and Infra', async ({ page }) => {
  await page.goto('/#daily');
  const p = panel(page, 'daily-hosts-attention');
  await expect(p.locator('tbody')).toBeVisible();
  const text = await p.locator('tbody').innerText();
  expect(text).not.toMatch(/\boffline\b|\bdegraded\b/);
  expect(text).toMatch(/Not online|Review/);
});

test('R3-A3: a figure that did not load says "Not checked" on Overview, Best practices and Value', async ({ page }) => {
  test.setTimeout(60_000);
  await failAll(page);
  await page.goto('/#best-practices');
  const tiles = page.locator('.bp-tiles');
  await expect(tiles).toBeVisible();
  await page.waitForTimeout(12_000);
  await expect(tiles).not.toContainText('unavailable');
  await expect(tiles).toContainText('Not checked');
  await page.goto('/#overview');
  await expect(page.locator('[data-dns-health]').first()).toBeVisible();
  await page.waitForTimeout(12_000);
  for (const line of await page.locator('[data-dns-health]').all()) {
    await expect(line).not.toContainText('not checked');
    await expect(line).toContainText('Not checked');
  }
  await page.goto('/#value');
  const work = panel(page, 'value-work');
  await expect(work).toBeVisible();
  await page.waitForTimeout(12_000);
  await expect(work).not.toContainText('not checked');
  await expect(work).toContainText('Not checked');
});

test('R3-A5: Value panels that missed figures use the shared failure look', async ({ page }) => {
  test.setTimeout(60_000);
  await failAll(page);
  await page.goto('/#value');
  await page.waitForTimeout(12_000);
  for (const id of ['value-security', 'value-platform']) {
    const missed = panel(page, id).locator('[data-panel-missed]');
    await expect(missed, id).toBeVisible();
    await expect(missed, id).not.toContainText('retries every');
    expect(await missed.evaluate((e) => getComputedStyle(e).fontSize), id).toBe('14px');
    const btn = missed.getByRole('button', { name: 'Try again' });
    expect(await btn.evaluate((e) => getComputedStyle(e).fontSize), id).toBe('14px');
  }
});

// Codex review of r3x: the DNS verdict read none of the answer shares, so
// every lookup failing still said Healthy. A Failed share of 5% or more is
// Review; "name not found" stays out of it, because it is normal.
const dnsHealth = (servfail: number, nxdomain: number) => {
  const m = (metric: string, unit: string, value: number) => ({ metric, unit, status: 'ok', value, hosts: [] });
  return {
    status: 'ok', window: 'last 24 hours',
    metrics: {
      answer_time: m('dns_latency_all_iq', 'seconds', 0.064),
      success: m('dns_success_percent_iq', 'percent', Math.max(0, 100 - servfail - nxdomain)),
      servfail: m('dns_servfail_percent_iq', 'percent', servfail),
      nxdomain: m('dns_nxdomain_percent_iq', 'percent', nxdomain),
    },
  };
};
const dnsVerdict = (page: Page) => page.getByRole('region', { name: 'Services at a glance' }).getByRole('button').filter({ hasText: /^DNS/ }).locator('.ov-verdict');

for (const [servfail, nxdomain, word] of [[6, 10, 'Review'], [100, 0, 'Review'], [5, 0, 'Review'], [4.9, 60, 'Healthy']] as const) {
  test(`DNS verdict: ${servfail}% failed and ${nxdomain}% name not found is ${word}`, async ({ page }) => {
    await page.route('**/api/csp/dns-health', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(dnsHealth(servfail, nxdomain)) }));
    await page.goto('/#overview');
    await expect(page.locator('[data-dns-health]').first()).toContainText(/Failed\s*\d/);
    await expect(dnsVerdict(page)).toHaveText(word);
  });
}
