import { test, expect } from '@playwright/test';

// Minimal NetworkData that satisfies the NetworkData shape (see
// src/types/network.ts) without triggering NetworkVertical's error
// branches — used once the app-stack is revealed post-login.
const EMPTY_NETWORK_DATA = {
  subnets: [],
  leases: [],
  zones: [],
  views: [],
};

test.describe('auth gate', () => {
  test('unauthenticated shows LoginScreen and no app-stack', async ({
    page,
  }) => {
    await page.route('**/auth/me', (route) =>
      route.fulfill({ status: 401, body: JSON.stringify({ error: 'unauthenticated' }) })
    );

    await page.goto('/index-vite.html');

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /dev sign in/i })
    ).toBeVisible();
    await expect(page.locator('.app-stack')).toHaveCount(0);
  });

  test('dev-login reveals the app-stack', async ({ page }) => {
    let loggedIn = false;

    await page.route('**/auth/me', (route) => {
      if (loggedIn) {
        return route.fulfill({
          status: 200,
          body: JSON.stringify({ email: 'test@x.com', role: 'operator' }),
        });
      }
      return route.fulfill({
        status: 401,
        body: JSON.stringify({ error: 'unauthenticated' }),
      });
    });

    await page.route('**/auth/dev-login', (route) => {
      loggedIn = true;
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.route('**/api/alerts/incidents', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify([]) })
    );
    await page.route('**/api/verticals/network', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify(EMPTY_NETWORK_DATA) })
    );

    await page.goto('/index-vite.html');

    await expect(
      page.getByRole('button', { name: /dev sign in/i })
    ).toBeVisible();

    await page.getByRole('textbox', { name: 'Email' }).fill('test@x.com');
    await page.getByRole('combobox', { name: 'Role' }).selectOption('operator');
    await page.getByRole('button', { name: /dev sign in/i }).click();

    await expect(page.locator('.app-stack')).toBeVisible();
  });

  test('admin sees the audit export button and can trigger a download', async ({
    page,
  }) => {
    let loggedIn = false;

    await page.route('**/auth/me', (route) => {
      if (loggedIn) {
        return route.fulfill({
          status: 200,
          body: JSON.stringify({ email: 'admin@x.com', role: 'admin' }),
        });
      }
      return route.fulfill({
        status: 401,
        body: JSON.stringify({ error: 'unauthenticated' }),
      });
    });

    await page.route('**/auth/dev-login', (route) => {
      loggedIn = true;
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.route('**/api/alerts/incidents', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify([]) })
    );
    await page.route('**/api/verticals/network', (route) =>
      route.fulfill({ status: 200, body: JSON.stringify(EMPTY_NETWORK_DATA) })
    );
    await page.route('**/api/audit/export', (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ entries: [], chain_valid: true, broken_index: null }),
      })
    );

    await page.goto('/index-vite.html');

    await page.getByRole('textbox', { name: 'Email' }).fill('admin@x.com');
    await page.getByRole('combobox', { name: 'Role' }).selectOption('admin');
    await page.getByRole('button', { name: /dev sign in/i }).click();

    await expect(page.locator('.app-stack')).toBeVisible();

    const exportButton = page.getByRole('button', { name: /export audit log/i });
    await expect(exportButton).toBeVisible();

    // AuditExportButton (src/components/AuditExportButton.tsx) builds a
    // Blob URL and clicks a synthetic <a download> element, which should
    // surface as a real Playwright `download` event.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportButton.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^audit-export-.*\.json$/);
  });
});
