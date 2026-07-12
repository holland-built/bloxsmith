import { test, expect } from '@playwright/test';

// The AI is now a persistent drawer (not a tab). Cmd/Ctrl+I toggles it; it stays
// mounted across tab switches AND across close (conversation survives); it POSTs
// /api/query with an implicit tab context. Closing hides it (visibility/transform),
// it is never unmounted, so items[] are retained.

const DATA = {
  subnets: [{ id: 's', name: 'N', addr: '10.0.0.0', cidr: 24, util: 50, site: 'HQ', total: 256 }],
  leases: [], zones: [], hosts: [], auditLogs: [], events: [],
};

test('Ctrl+I opens the AI drawer, it persists across tabs, answers, and closes (stays mounted)', async ({ page }) => {
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

  const drawer = page.locator('.ai-drawer');
  const trigger = page.getByRole('button', { name: 'Open AI assistant' });

  // (d) trigger reflects closed state.
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // Open via real keyboard.
  await page.keyboard.press('Control+i');
  await expect(drawer).toBeVisible();

  // (a) open sets [data-open] and the slide lands on transform:none.
  await expect(drawer).toHaveAttribute('data-open', '');
  await expect(drawer).toHaveCSS('transform', 'none');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

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

  // (b) Escape closes -> drawer hidden but STILL mounted (count stays 1).
  await input.focus();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(drawer).toHaveCount(1);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // Reopen -> the prior conversation item SURVIVED (was not destroyed on close).
  await page.keyboard.press('Control+i');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.ask-a')).toContainText('nearly full');
});

test('click-off on a panel closes the drawer (non-modal dismiss)', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto('/#overview', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  const drawer = page.locator('.ai-drawer');
  const trigger = page.getByRole('button', { name: 'Open AI assistant' });

  // (d) open via the trigger; aria-expanded flips true.
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  // (c) pointerdown outside the drawer (on the main content) dismisses it.
  await page.locator('.main').click({ position: { x: 5, y: 5 } });
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
