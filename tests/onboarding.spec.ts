import { test, expect, type Page } from '@playwright/test';

async function mockAuthedAsViewer(page: Page) {
  await page.route('**/auth/me', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ email: 'test@x.com', role: 'operator' }) })
  );
}

const EMPTY_NETWORK_DATA = {
  subnets: [],
  leases: [],
  zones: [],
  views: [],
};

async function mockVerticals(page: Page) {
  await page.route('**/api/alerts/incidents', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([]) })
  );
  await page.route('**/api/verticals/network', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify(EMPTY_NETWORK_DATA) })
  );
}

test.describe('onboarding banner', () => {
  test('shows on first visit', async ({ page }) => {
    await mockAuthedAsViewer(page);
    await mockVerticals(page);

    await page.goto('/index-vite.html');

    await expect(page.locator('.onboarding-banner')).toBeVisible();
  });

  test('dismissing persists across a reload', async ({ page }) => {
    await mockAuthedAsViewer(page);
    await mockVerticals(page);

    await page.goto('/index-vite.html');

    await expect(page.locator('.onboarding-banner')).toBeVisible();
    await page.locator('.onboarding-dismiss').click();
    await expect(page.locator('.onboarding-banner')).toHaveCount(0);

    const stored = await page.evaluate(() =>
      localStorage.getItem('noc.onboarding.dismissed')
    );
    expect(stored).toBe('1');

    await page.reload();

    await expect(page.locator('.onboarding-banner')).toHaveCount(0);
  });
});
