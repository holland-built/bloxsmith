import { test, expect } from '@playwright/test';

// Precondition (the Triage Inbox must have at least one row before the Block
// button can even be clicked) is stubbed deterministically instead of relying
// on live tenant data — see go/internal/dashboard/hub.go's FetchHubSecurity
// for the `availability: "ok"` shape and tests/hub-security-availability.spec.ts
// for the established fixture fields. Without this stub, a Security tab that
// renders zero rows for ANY reason (including a dead dns_event feed) would
// previously report GREEN via a swallowed test.skip.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const HUB_SECURITY_ONE_EVENT = {
  events: [
    {
      event_time: '2026-07-28T00:00:00Z',
      qname: 'evil.example.com',
      severity: 'critical',
      policy_action: 'log',
      feed_name: 'test-feed',
      threat_indicator: 'malware',
      device: '',
      network: '',
    },
  ],
  counts: { critical: 1, high: 0, medium: 0, low: 0 },
  blocked: 0,
  logged: 1,
  total: 1,
  availability: 'ok',
};

test('block-domain 401 with no dashToken surfaces "token required" message', async ({ page }) => {
  await page.route('**/api/hub/security*', (route) => fulfillJson(route, HUB_SECURITY_ONE_EVENT));

  await page.route('**/api/block-domain', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'unauthorized' }),
    }),
  );

  await page.goto('/#security');

  const dashToken = await page.evaluate(() => localStorage.getItem('dashToken'));
  expect(dashToken).toBeNull();

  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();

  await rows.first().getByRole('button', { name: 'Block' }).click();
  await expect(page.getByText(/token required.*Settings/)).toBeVisible();
});
