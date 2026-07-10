import { test, expect } from '@playwright/test';

// Command palette fuzzy go-to: typing a subnet address surfaces a "Go: <addr>"
// jump that navigates to #network?peek=<addr> and opens that subnet's peek
// (subnets DataTable initialPeekKey). Clicks the result row for resilience.

const DATA = {
  subnets: [{ id: 's-x', name: 'Palette Net', addr: '10.55.55.0', cidr: 24, util: 50, site: 'HQ' }],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

test('palette go-to jumps to a subnet and opens its peek', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.goto('/');
  await expect(page.locator('.tabbar')).toBeVisible();

  await page.keyboard.press('Meta+k');
  const input = page.locator('.palette-in');
  await expect(input).toBeVisible();

  await input.fill('10.55.55.0');
  const go = page.locator('.pal-row', { hasText: 'Go: 10.55.55.0' });
  await expect(go).toBeVisible();
  await go.click();

  await expect(page).toHaveURL(/#network\?peek=10\.55\.55\.0/);
  const peek = page.locator('.peek');
  await expect(peek).toBeVisible();
  await expect(peek).toContainText('10.55.55.0');
});
