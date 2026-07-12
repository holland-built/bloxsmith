import { test, expect } from '@playwright/test';

// Command palette ACTIONS: "Export current view" (CSV of the active table) and
// "Ask AI about selection" (opens the AI drawer seeded with selected rows).

// This worktree's normal :8080 target is a Docker image build owned by a
// concurrent session; point this spec at a locally-run `server.py` instance
// instead so it reflects live source without touching that container.
test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const WRAP = 'div[tabindex="0"]:has(tr.clickable)'; // subnets wrapper (clickable rows)

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 80, site: 'DR' },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 24, util: 72, site: 'BR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

test('palette "Export current view" downloads a CSV of the active table', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/#network');

  const rows = page.locator(`${WRAP} tbody tr`);
  await expect(rows.first()).toBeVisible();

  await page.keyboard.press('Meta+k');
  const input = page.locator('.palette-in');
  await expect(input).toBeVisible();
  await input.fill('export current');

  const item = page.locator('.pal-row', { hasText: 'Export current view' });
  await expect(item).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    item.click(),
  ]);
  expect(download.suggestedFilename()).toContain('subnets');

  // Palette closes after running the action.
  await expect(page.locator('.palette-in')).toHaveCount(0);
});

test('palette "Ask AI about selection" opens the drawer seeded with selected rows', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  let lastBody: any = null;
  await page.route('**/api/query', route => {
    try { lastBody = JSON.parse(route.request().postData() || '{}'); } catch { lastBody = {}; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: 'ok', suggestions: [] }) });
  });
  await page.goto('/#network');

  const rows = page.locator(`${WRAP} tbody tr`);
  await expect(rows.first()).toBeVisible();
  await rows.first().locator('input[aria-label="Select row"]').check();

  await page.keyboard.press('Meta+k');
  const input = page.locator('.palette-in');
  await expect(input).toBeVisible();

  const item = page.locator('.pal-row', { hasText: 'Ask AI about selection' });
  await expect(item).toBeVisible();
  await item.click();

  const drawer = page.locator('.ai-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.ask-q').first()).toContainText('Alpha Net');
  expect(lastBody).not.toBeNull();

  // Palette closes after running the action.
  await expect(page.locator('.palette-in')).toHaveCount(0);
});
