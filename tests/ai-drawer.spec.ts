import { test, expect } from '@playwright/test';

// The AI is now a persistent drawer (not a tab). Cmd/Ctrl+I toggles it; it stays
// mounted across tab switches; it POSTs /api/query with an implicit tab context.

const DATA = {
  subnets: [{ id: 's', name: 'N', addr: '10.0.0.0', cidr: 24, util: 50, site: 'HQ', total: 256 }],
  leases: [], zones: [], hosts: [], auditLogs: [], events: [],
};

test('Ctrl+I opens the AI drawer, it persists across tabs, answers, and closes', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  let lastBody: any = null;
  await page.route('**/api/query', route => {
    try { lastBody = JSON.parse(route.request().postData() || '{}'); } catch { lastBody = {}; }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ answer: 'Two subnets are nearly full.', suggestions: [] }),
    });
  });

  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  // Open via real keyboard.
  await page.keyboard.press('Control+i');
  const drawer = page.locator('.ai-drawer');
  await expect(drawer).toBeVisible();

  // Switch tabs -> drawer stays mounted (shell-level state).
  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(drawer).toBeVisible();

  // Ask a question.
  const input = drawer.locator('.ask-in');
  await input.fill('which subnets are nearly full?');
  await drawer.getByRole('button', { name: 'Ask' }).click();

  await expect(drawer.locator('.ask-a')).toContainText('nearly full');

  // POST body carries an implicit context mentioning the active tab.
  expect(lastBody).not.toBeNull();
  expect(String(lastBody.context)).toContain('network');

  // Escape (focus inside the drawer) closes it.
  await input.focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ai-drawer')).toHaveCount(0);
});
