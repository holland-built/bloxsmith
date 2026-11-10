import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Traffic (Kentik) row on the search result page. Each state is faked with
// page.route; the server side of each is proved in
// go/internal/dashboard/kentik_test.go. What only a browser shows: the states
// read differently, and "not set up" or "failed" never reads as no traffic.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const row = (page: import('@playwright/test').Page) => page.locator('[data-dossier-section="kentik"]');
const state = (page: import('@playwright/test').Page) => page.locator('[data-dossier-source="kentik"]');

// The 172.16.0.210 answer from the demo account on 2026-11-10, trimmed.
const LOADED = {
  availability: 'ok',
  configured: true,
  ip: '172.16.0.210',
  window_sec: 3600,
  bps_out: 6298,
  bps_in: 52.44,
  rows: [
    { direction: 'out', peer: '10.67.70.10', protocol: 'UDP (17)', port: 9995, bps: 6212 },
    { direction: 'in', peer: '172.16.0.222', protocol: 'TCP (6)', port: 179, bps: 37.78 },
  ],
};

function fake(page: import('@playwright/test').Page, body: unknown) {
  return page.route('**/api/kentik/traffic*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

test('an IP shows its totals and busiest conversations', async ({ page }) => {
  await fake(page, LOADED);
  await page.goto('/#dossier?q=172.16.0.210');
  await expect(state(page)).toHaveAttribute('data-dossier-state', 'ok', { timeout: 20_000 });
  await expect(row(page)).toContainText('6.3 kb/s');
  await expect(row(page)).toContainText('52 b/s');
  await expect(row(page)).toContainText('10.67.70.10');
  await expect(row(page)).toContainText('UDP 9995');
  await expect(row(page)).toContainText('received from');
  await expect(row(page)).toContainText('TCP 179');
});

test('no login saved says where to set it, and never "no traffic"', async ({ page }) => {
  await page.goto('/#dossier?q=172.16.0.210');
  await expect(state(page)).toHaveAttribute('data-dossier-state', 'unsupported', { timeout: 20_000 });
  await expect(row(page)).toContainText('Settings, under Integrations');
  await expect(row(page)).not.toContainText('saw no traffic');
});

test('a failed read is unknown, never "no traffic"', async ({ page }) => {
  await fake(page, { availability: 'error', configured: true, rows: [], reason: 'Kentik answered HTTP 502' });
  await page.goto('/#dossier?q=172.16.0.210');
  await expect(state(page)).toHaveAttribute('data-dossier-state', 'error', { timeout: 20_000 });
  await expect(row(page)).toContainText('HTTP 502');
  await expect(row(page)).not.toContainText('saw no traffic');
});

test('Kentik answering with nothing is the only way to read "no traffic"', async ({ page }) => {
  await fake(page, { ...LOADED, bps_out: 0, bps_in: 0, rows: [] });
  await page.goto('/#dossier?q=172.16.0.210');
  await expect(state(page)).toHaveAttribute('data-dossier-state', 'none', { timeout: 20_000 });
  await expect(row(page)).toContainText('saw no traffic');
});

test('a host name never asks Kentik', async ({ page }) => {
  let asked = false;
  await page.route('**/api/kentik/traffic*', (route) => {
    asked = true;
    return route.abort();
  });
  await page.goto('/#dossier?q=baseline.example');
  await expect(state(page)).toHaveAttribute('data-dossier-state', 'na', { timeout: 20_000 });
  expect(asked).toBe(false);
});
