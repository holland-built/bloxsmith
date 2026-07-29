import { test, expect } from './fixtures';

// Backend contract (go/internal/dashboard/hub.go): /api/hub/security's
// dns_event read now goes through rest.GetStrict and publishes an explicit
// `availability` of "ok" | "error" alongside its rows, always as HTTP
// 200 — so ui/src/lib/api.js's `.error` (set only on !res.ok) stays null even
// when the upstream threat-event feed is dead. Before this fix, a failed read
// fell back to Rest.Get's swallow-to-[] behavior and rendered exactly like a
// clean network with zero threats — a failure that read as safety. These
// specs prove the three hub-backed Security panels (Threat Events, Response
// Summary, Triage Inbox) branch on `availability`, not on the always-null
// `.error`, and that one dead feed never blanks the rest of the tab.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const HUB_SECURITY_DEAD = {
  events: [],
  counts: { critical: 0, high: 0, medium: 0, low: 0 },
  blocked: 0,
  logged: 0,
  total: 0,
  availability: 'error',
  reason: 'threat-event feed unavailable',
};

const HUB_SECURITY_EMPTY_OK = {
  events: [],
  counts: { critical: 0, high: 0, medium: 0, low: 0 },
  blocked: 0,
  logged: 0,
  total: 0,
  availability: 'ok',
};

test.describe('Security tab — hub/security availability branching', () => {
  test('dead dns_event feed shows unavailable wording on every hub-backed panel, not "no threats"', async ({ page }) => {
    await page.route('**/api/hub/security*', (route) => fulfillJson(route, HUB_SECURITY_DEAD));
    await page.goto('/#security');

    const heroCard = page.locator('text=Threat Events — by Severity').locator('..').locator('..');
    await expect(heroCard.getByText(/threat feed unavailable/i)).toBeVisible();
    await expect(heroCard.getByText('threat-event feed unavailable')).toBeVisible();

    const summaryCard = page.locator('text=Response Summary').locator('..').locator('..');
    await expect(summaryCard.getByText(/threat feed unavailable/i)).toBeVisible();

    const inboxCard = page.locator('text=Triage Inbox').locator('..').locator('..');
    await expect(inboxCard.getByText(/threat feed unavailable/i)).toBeVisible();

    // One dead feed must never blank the rest of the Security tab — an
    // unrelated card still renders.
    await expect(page.getByText('Lookalike Domains')).toBeVisible();
  });

  test('genuinely empty dns_event feed renders the normal empty state, not unavailable', async ({ page }) => {
    await page.route('**/api/hub/security*', (route) => fulfillJson(route, HUB_SECURITY_EMPTY_OK));
    await page.goto('/#security');

    const heroCard = page.locator('text=Threat Events — by Severity').locator('..').locator('..');
    await expect(heroCard.getByText(/threat feed unavailable/i)).toHaveCount(0);

    const summaryCard = page.locator('text=Response Summary').locator('..').locator('..');
    await expect(summaryCard.getByText(/threat feed unavailable/i)).toHaveCount(0);
    // Response Summary still renders its zeroed KPI grid rather than a
    // feed-unavailable card.
    await expect(summaryCard.getByText('Unacked Critical')).toBeVisible();

    const inboxCard = page.locator('text=Triage Inbox').locator('..').locator('..');
    await expect(inboxCard.getByText(/threat feed unavailable/i)).toHaveCount(0);
  });
});
