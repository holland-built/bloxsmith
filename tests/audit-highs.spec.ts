import { test, expect } from '@playwright/test';

// design-audit exit-gate fixes (HIGH + cheap MEDIUM):
//   H1 — the Overview "Hosts" stat triad must carry a VISIBLE per-segment text cue
//        (up/deg/down), so state is never conveyed by color+position alone.
//   H2 — WatchMenu popover must match the shared KebabMenu/AbMenu menu behaviour:
//        role=menu, items role=menuitem, first item focused on open, Esc closes +
//        returns focus to the trigger.
//   MED — wallboard view indicators must NOT be a role=tablist with no real tabs.
// Runs against the same throwaway working-tree server as the sibling specs.
test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const HOSTS = [
  { id: 'h1', name: 'ns-01',   ip: '10.0.0.1', type: 'server', status: 'online'   },
  { id: 'h2', name: 'ns-02',   ip: '10.0.0.2', type: 'server', status: 'online'   },
  { id: 'h3', name: 'dhcp-01', ip: '10.0.0.3', type: 'server', status: 'degraded' },
  { id: 'h4', name: 'edge-01', ip: '10.0.0.4', type: 'router', status: 'offline'  },
];
const SUBNETS = [
  { id: 's1', addr: '10.1.0.0', cidr: 24, util: 95, name: 'A', site: 'HQ' },
  { id: 's2', addr: '10.2.0.0', cidr: 24, util: 40, name: 'B', site: 'DR' },
];
const DATA = { subnets: SUBNETS, leases: [], zones: [], hosts: HOSTS, auditLogs: [], events: [] };

async function mock(page: any) {
  await page.route('**/api/data', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) }));
  await page.route('**/api/hub/security', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ counts: {}, events: [] }) }));
}

test('H1 — Hosts stat triad shows a visible text cue per segment, not a bare number', async ({ page }) => {
  await mock(page);
  await page.goto('/#overview', { waitUntil: 'networkidle' });

  const online = page.locator('[data-scope="status:online"]');
  const degraded = page.locator('[data-scope="status:degraded"]');
  const offline = page.locator('[data-scope="status:offline"]');
  await expect(online).toBeVisible();

  // Each segment carries its number AND a visible word — NOT color+position only.
  await expect(online).toContainText('2');
  await expect(online).toContainText('up');
  await expect(degraded).toContainText('1');
  await expect(degraded).toContainText('deg');
  await expect(offline).toContainText('1');
  await expect(offline).toContainText('down');

  // Hard gate: visible text is more than digits/whitespace alone.
  for (const seg of [online, degraded, offline]) {
    const txt = (await seg.textContent()) || '';
    expect(/[a-z]/i.test(txt)).toBeTruthy();
  }
});

test('H2 — WatchMenu: role=menu, menuitems, first-item focus on open, Esc closes + returns focus', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bx.watches',
    JSON.stringify([{ name: 'high-util', tab: 'network', query: 'util>85', created: 1 }])));
  await mock(page);
  await page.goto('/#overview', { waitUntil: 'networkidle' });

  const trigger = page.getByRole('button', { name: /Watches/ });
  await trigger.click();

  const menu = page.locator('.views-menu[role="menu"]');
  await expect(menu).toBeVisible();

  // Items carry role=menuitem (shared KebabMenu/AbMenu contract).
  await expect(menu.locator('[role="menuitem"]').first()).toBeVisible();
  expect(await menu.locator('[role="menuitem"]').count()).toBeGreaterThan(1);

  // First item is focused on open.
  await expect(menu.locator('button:not(:disabled)').first()).toBeFocused();

  // Arrow roving moves focus within the menu.
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('button:not(:disabled)').first()).not.toBeFocused();

  // Esc closes and returns focus to the trigger.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('MED — wallboard view indicators are not a role=tablist with no real tabs', async ({ page }) => {
  await mock(page);
  await page.goto('/#wall', { waitUntil: 'networkidle' });

  const views = page.locator('.wall-views');
  await expect(views).toBeVisible();
  // No phantom tablist / tab semantics.
  await expect(views).not.toHaveAttribute('role', 'tablist');
  expect(await page.locator('.wall-views [role="tab"]').count()).toBe(0);
});
