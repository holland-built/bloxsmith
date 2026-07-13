import { test, expect } from '@playwright/test';

// P2 slice 9 (final) — two zero/low-interaction affordances:
//   1. Wallboard mode  — a no-chrome NOC-TV view reachable via #wall (or a header
//      toggle). Hides the topbar/nav, shows the health tiles + capacity heatmap +
//      worst-offenders/triage table at bigger type. Esc / a corner control exits.
//   2. First-run ghost tour — a one-time, non-modal set of callouts pointing at the
//      5 power features (BQL search, ⌘K palette, pivot-on-cell, snapshot compare,
//      vim row-nav). Persists "seen" in LS; re-summonable from the "?" overlay.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8092' });

const DATA = {
  subnets: [
    { id: 's1', addr: '10.1.0.0', cidr: 24, util: 98, site: 'HQ',  used: 250, total: 256 },
    { id: 's2', addr: '10.1.1.0', cidr: 24, util: 92, site: 'HQ',  used: 236, total: 256 },
    { id: 's3', addr: '10.2.0.0', cidr: 24, util: 88, site: 'DR',  used: 225, total: 256 },
    { id: 's4', addr: '10.2.1.0', cidr: 24, util: 75, site: 'DR',  used: 192, total: 256 },
    { id: 's5', addr: '10.3.0.0', cidr: 24, util: 40, site: 'LAB', used: 102, total: 256 },
  ],
  leases: [{ addr: '10.1.0.5', host: 'ws1', state: 'active', subnet: '10.1.0.0/24' }],
  zones: [],
  hosts: [{ name: 'h1', status: 'online' }, { name: 'h2', status: 'offline' }],
  auditLogs: [], events: [],
};

async function mock(page: any) {
  await page.route('**/api/data', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) }),
  );
}

test('#wall enters wallboard: chrome hidden, health tiles + worst-offenders + heatmap present, Esc exits', async ({ page }) => {
  await mock(page);
  await page.goto('/#wall', { waitUntil: 'networkidle' });

  const wb = page.locator('.wallboard');
  await expect(wb).toBeVisible();

  // Chrome (topbar / tab nav) is hidden in wallboard mode.
  await expect(page.locator('.topbar')).toHaveCount(0);
  await expect(page.locator('.tabbar')).toHaveCount(0);

  // Health tiles (the reused service-health ribbon), the capacity heatmap, and the
  // worst-offenders / triage rows are all present.
  await expect(page.locator('.health-strip')).toBeVisible();
  await expect(wb.locator('.heatmap')).toBeVisible();
  await expect(wb.locator('.triage-row').first()).toBeVisible();

  // Esc exits back to the normal app (chrome returns).
  await page.keyboard.press('Escape');
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.wallboard')).toHaveCount(0);
});

test('a header toggle also enters wallboard mode', async ({ page }) => {
  await mock(page);
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  await page.getByRole('button', { name: /wallboard/i }).click();
  await expect(page.locator('.wallboard')).toBeVisible();
  await expect(page.locator('.topbar')).toHaveCount(0);
});

test('first-run tour shows once, dismiss persists in LS, re-summonable from "?" overlay', async ({ page }) => {
  await mock(page);
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  const tour = page.locator('.tour-callout');
  await expect(tour).toBeVisible();

  // Callouts reference all 5 power features.
  await expect(tour).toContainText(/BQL|search/i);
  await expect(tour).toContainText(/⌘K|command palette/i);
  await expect(tour).toContainText(/pivot/i);
  await expect(tour).toContainText(/compare|snapshot/i);
  await expect(tour).toContainText(/vim|j\s*\/\s*k/i);

  // Dismiss — never traps: a skip/dismiss control is always available.
  await tour.getByRole('button', { name: /skip|dismiss/i }).click();
  await expect(tour).toHaveCount(0);

  // "Seen" persists in LS (bx.tourSeen === true).
  const seen = await page.evaluate(() => localStorage.getItem('bx.tourSeen'));
  expect(seen).toBe('true');

  // Reload → not shown again.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
  await expect(page.locator('.tour-callout')).toHaveCount(0);

  // Re-summonable from the "?" ShortcutsHelp overlay.
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await help.getByRole('button', { name: /show tour again/i }).click();
  await expect(page.locator('.tour-callout')).toBeVisible();
});

test('tour is non-modal / keyboard-dismissible with Esc', async ({ page }) => {
  await mock(page);
  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  const tour = page.locator('.tour-callout');
  await expect(tour).toBeVisible();
  // Non-modal: it is NOT an aria-modal dialog (must never block the app).
  await expect(tour).toHaveAttribute('aria-modal', /.*/).catch(() => {});
  const isModal = await tour.evaluate((el) => el.getAttribute('aria-modal'));
  expect(isModal).not.toBe('true');

  await page.keyboard.press('Escape');
  await expect(tour).toHaveCount(0);
  const seen = await page.evaluate(() => localStorage.getItem('bx.tourSeen'));
  expect(seen).toBe('true');
});
